import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Bot, Crown, Flame, Medal, Shield, Sparkles } from "lucide-react";
import { PlayingCard } from "@/components/PlayingCard";
import { Burst } from "@/components/game/Effects";
import { REASON_LABEL, TEAM_NAME, VICTORY_LABEL } from "@/lib/api";
import { sound } from "@/lib/sound";
import { floored, medalShort, medalSummary, netChange, signed, victoryName } from "@/components/medals/medalText";

export const ALL_TENS = ["10S", "10H", "10D", "10C"];
export const RESULTS_VISIBLE_MS = 10000;
const DEFAULT_REVEAL_DELAY_MS = 1400;

/**
 * Which team captured each ten, from the server's per-round snapshot only.
 * Returns null for rounds recorded before the snapshot existed (counts only, never guessed).
 */
export function tenOwnership(result) {
  const captured = result?.captured_tens;
  if (!Array.isArray(captured) || captured.length !== 2 || !captured.every(Array.isArray)) return null;
  const owners = {};
  for (const card of ALL_TENS) {
    const teams = [0, 1].filter((team) => captured[team].includes(card));
    owners[card] = teams.length === 1 ? teams[0] : null;
  }
  return owners;
}

function msUntil(iso, serverOffsetMs) {
  const deadline = Date.parse(iso || "");
  if (!Number.isFinite(deadline)) return null;
  return Math.max(0, deadline - (Date.now() + (serverOffsetMs || 0)));
}

function useCountdown(nextRoundAt, serverOffsetMs) {
  const [remaining, setRemaining] = useState(() => msUntil(nextRoundAt, serverOffsetMs));
  useEffect(() => {
    setRemaining(msUntil(nextRoundAt, serverOffsetMs));
    if (!nextRoundAt) return undefined;
    const id = setInterval(() => setRemaining(msUntil(nextRoundAt, serverOffsetMs)), 100);
    return () => clearInterval(id);
  }, [nextRoundAt, serverOffsetMs]);
  return remaining;
}

function reasonText(result) {
  return REASON_LABEL[result.reason] || result.reason || "";
}

// Medal and title colours by how the round was won (same palette as the match-over plaque).
const ROUND_TONE = {
  normal: { Icon: Sparkles, medal: "from-emerald-200 via-emerald-400 to-emerald-800", ring: "ring-emerald-200/40", chip: "border-emerald-300/40 bg-emerald-400/10 text-emerald-200" },
  koth: { Icon: Crown, medal: "from-amber-100 via-amber-300 to-amber-700", ring: "ring-amber-100/50", chip: "border-amber-300/50 bg-amber-400/10 text-amber-200" },
  grand_slam: { Icon: Flame, medal: "from-rose-200 via-rose-400 to-rose-800", ring: "ring-rose-200/40", chip: "border-rose-300/50 bg-rose-400/10 text-rose-200" },
};
const TEAM_TONE = [
  { band: "from-sky-400 to-sky-600", text: "text-sky-200", bar: "from-sky-300 to-sky-500" },
  { band: "from-amber-400 to-amber-600", text: "text-amber-200", bar: "from-amber-300 to-amber-500" },
];

function Stat({ value, label, testid, children }) {
  return (
    <div className="rounded-xl border border-white/5 bg-black/30 px-2 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,.04)]">
      <div className="font-mono text-2xl font-bold leading-none text-white sm:text-3xl" data-testid={testid}>{value}</div>
      <div className="mt-1 whitespace-nowrap text-[9px] font-semibold uppercase tracking-wider text-white/45">{label}</div>
      {children}
    </div>
  );
}

function TeamPanel({ team, result, owners, players, mySeat, revealDelay }) {
  const winner = result.winner_team === team;
  const tone = TEAM_TONE[team];
  const tricks = result.tricks_won?.[team] ?? 0;
  const tensCount = result.tens?.[team] ?? 0;
  const members = players.filter((p) => p.team === team).sort((a, b) => a.seat - b.seat);
  const mine = mySeat !== null && mySeat !== undefined && mySeat % 2 === team;
  const cards = owners ? ALL_TENS.filter((card) => owners[card] === team) : [];
  return (
    <motion.section data-testid={`round-team-panel-${team}`} data-winner={winner ? "true" : "false"}
      initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: revealDelay + 0.25 + team * 0.08, duration: 0.4 }}
      className={`relative min-w-0 overflow-visible rounded-2xl border p-3 pt-4 sm:p-4 sm:pt-5 ${winner
        ? "border-amber-300/70 bg-gradient-to-b from-amber-300/[0.14] via-amber-900/[0.06] to-black/30 shadow-[0_0_34px_-8px_rgba(251,191,36,.55)]"
        : "border-white/10 bg-gradient-to-b from-white/[0.04] to-black/25"}`}>
      <span className={`absolute inset-x-4 top-0 h-[3px] rounded-b-full bg-gradient-to-r ${tone.band} ${winner ? "" : "opacity-60"}`} aria-hidden="true" />
      {winner && (
        <span className="absolute -top-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-full border border-amber-100/70 bg-gradient-to-r from-amber-200 to-amber-400 px-2.5 py-0.5 text-[10px] font-black uppercase tracking-wider text-slate-950 shadow-[0_6px_14px_-6px_rgba(0,0,0,.9)]" data-testid={`round-team-winner-${team}`}>
          <Crown size={11} /> Winner
        </span>
      )}
      <div className="flex items-center justify-between gap-2">
        <h3 className={`min-w-0 truncate whitespace-nowrap font-display text-sm min-[360px]:text-base sm:text-lg ${winner ? "text-amber-100" : "text-white/85"}`}>{TEAM_NAME[team]}</h3>
        {mine && <span className="shrink-0 rounded-full border border-emerald-300/30 bg-emerald-400/10 px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-emerald-200">You</span>}
      </div>
      <p className={`mt-0.5 truncate text-[11px] ${tone.text} opacity-80`}>{members.map((p) => p.display_name || p.username).join(" · ") || "—"}</p>

      <div className="mt-3 grid grid-cols-2 gap-2 text-center">
        <Stat value={tricks} label="tricks" testid={`round-team-tricks-${team}`}>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/10">
            <div className={`h-full rounded-full bg-gradient-to-r ${winner ? "from-amber-200 to-amber-400" : tone.bar} ${winner ? "" : "opacity-70"}`} style={{ width: `${Math.min(100, (tricks / 13) * 100)}%` }} />
          </div>
        </Stat>
        <Stat value={tensCount} label="tens / 4" testid={`round-team-tens-${team}`}>
          <div className="mt-1.5 flex justify-center gap-1" aria-hidden>
            {ALL_TENS.map((card, i) => <span key={card} className={`h-1 w-3 rounded-full ${i < tensCount ? (winner ? "bg-amber-300" : "bg-white/60") : "bg-white/10"}`} />)}
          </div>
        </Stat>
      </div>

      {/* Narrow screens overlap the captured tens so all four fit on one row; wider screens space them out. */}
      <div className="mt-3 flex min-h-[64px] items-center justify-center -space-x-5 rounded-xl min-[360px]:-space-x-4 border border-dashed border-white/10 bg-black/15 px-1 py-2 min-[420px]:-space-x-2 sm:flex-wrap sm:gap-1.5 sm:space-x-0" data-testid={`round-team-cards-${team}`}>
        {owners && cards.length === 0 && <span className="text-[11px] italic text-white/35">No tens captured</span>}
        {cards.map((card) => (
          <motion.div key={card} data-testid={`round-ten-${card}`} data-owner={team}
            initial={{ opacity: 0, rotateY: 90, y: 10 }} animate={{ opacity: 1, rotateY: 0, y: 0 }}
            transition={{ delay: revealDelay + 0.55 + ALL_TENS.indexOf(card) * 0.18, duration: 0.45, ease: "easeOut" }}
            className={winner ? "drop-shadow-[0_6px_14px_rgba(251,191,36,.35)]" : "drop-shadow-[0_6px_12px_rgba(0,0,0,.45)]"}>
            <PlayingCard card={card} size="sm" />
          </motion.div>
        ))}
      </div>
    </motion.section>
  );
}

// Medal changes for this round, exactly as the server stored them (backend/medals.py): each winner gets
// their trick medals + ten bonus + the victory bonus; each loser loses the victory penalty, never going
// below zero. Bot matches never change medals.
export function RoundMedals({ medals, eligible, players, mySeat, revealDelay = 0 }) {
  if (eligible === false) {
    return (
      <p className="relative mt-3 flex items-center justify-center gap-1.5 text-center text-[11px] text-white/45" data-testid="round-medals-unavailable">
        <Bot size={12} aria-hidden="true" /> Medals are earned only in matches without bots.
      </p>
    );
  }
  if (!medals || !Array.isArray(medals.players)) return null;
  const nameOf = (uid) => {
    const p = players.find((x) => x.user_id === uid);
    return p ? (p.display_name || p.username) : "Player";
  };
  const isWinner = (p) => (p.won !== undefined ? p.won : p.team === medals.winner_team);
  const winners = medals.players.filter(isWinner).sort((a, b) => a.seat - b.seat);
  const losers = medals.players.filter((p) => !isWinner(p)).sort((a, b) => a.seat - b.seat);
  const mine = mySeat !== null && mySeat !== undefined ? medals.players.find((p) => p.seat === mySeat) : null;
  const penalty = losers[0]?.penalty || 0;
  return (
    <motion.section className="relative mt-2 rounded-2xl border border-orange-300/25 bg-gradient-to-b from-orange-300/[0.08] to-black/25 px-2.5 py-1.5 sm:px-3" data-testid="round-medals"
      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: revealDelay + 0.9, duration: 0.35 }}>
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-orange-200/85"><Medal size={12} aria-hidden="true" /> Medals this round</span>
        {mine && mine.balance_after !== null && mine.balance_after !== undefined ? (
          <span className="text-[10px] text-white/60" data-testid="round-medals-balance">
            You {signed(netChange(mine))} · balance <b className="font-mono text-orange-200">{Number(mine.balance_after).toLocaleString("en-IN")}</b>
          </span>
        ) : <span className="text-[9px] text-white/40">1 per trick · +3 per ten · win bonus</span>}
      </div>
      <ul className={`mt-1 grid grid-cols-2 gap-1.5 ${losers.length ? "sm:grid-cols-3" : ""}`}>
        {winners.map((p, i) => {
          const isMe = mine && p.seat === mine.seat;
          const net = netChange(p);
          return (
            <li key={p.seat} className={`min-w-0 rounded-xl border px-2 py-1 ${isMe ? "border-orange-200/60 bg-orange-300/15" : "border-white/10 bg-black/25"}`}
              data-testid={`round-medals-seat-${p.seat}`} title={medalSummary(p, medals.type)}>
              <span className="flex items-center justify-between gap-1.5">
                <span className="min-w-0 truncate text-xs font-semibold text-white/90">{nameOf(p.user_id)}{isMe && <span className="ml-1 text-[9px] font-bold uppercase tracking-wider text-orange-200">You</span>}</span>
              <motion.span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-gradient-to-br from-amber-100 via-amber-300 to-orange-500 px-1.5 py-px font-mono text-xs font-black text-slate-950 shadow-[0_4px_12px_-4px_rgba(251,146,60,.7)]"
                initial={{ scale: 0.3, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: revealDelay + 1.1 + i * 0.15, type: "spring", stiffness: 320, damping: 15 }} data-testid={`round-medals-value-${p.seat}`}>
                <Medal size={12} aria-hidden="true" />{signed(net)}
              </motion.span>
              </span>
              <span className="mt-0.5 block text-[10px] leading-snug text-white/55" data-testid={`round-medals-parts-${p.seat}`}>{medalShort(p, medals.type)}</span>
            </li>
          );
        })}
        {losers.length > 0 && (
          <li className="col-span-2 flex min-w-0 flex-col justify-center gap-0.5 rounded-xl border border-rose-300/20 bg-rose-950/20 px-2 py-1 text-[11px] sm:col-span-1" data-testid="round-medals-losers">
            <span className="text-[10px] text-rose-200/80">{victoryName(medals.type)} loss penalty {signed(-penalty)} each</span>
            <span className="flex flex-wrap gap-x-2.5 gap-y-0.5">
              {losers.map((p) => {
                const isMe = mine && p.seat === mine.seat;
                return (
                  <span key={p.seat} className={`inline-flex min-w-0 items-center gap-1 ${isMe ? "font-semibold text-white" : "text-white/70"}`} data-testid={`round-medals-loser-${p.seat}`}
                    title={medalSummary(p, medals.type)}>
                    <span className="truncate">{nameOf(p.user_id)}{isMe ? " (you)" : ""}</span>
                    <b className="font-mono text-rose-200" data-testid={`round-medals-value-${p.seat}`}>{signed(netChange(p))}</b>
                    {floored(p) && <span className="whitespace-nowrap text-[10px] text-white/45">(only {Math.abs(netChange(p))} to take)</span>}
                  </span>
                );
              })}
            </span>
          </li>
        )}
      </ul>
    </motion.section>
  );
}
export function RoundResultScreen({ result, round, scores = [0, 0], target, mySeat, players = [], nextRoundAt,
  serverOffsetMs = 0, spectator = false, medals = null, medalsEligible }) {
  const remaining = useCountdown(nextRoundAt, serverOffsetMs);
  // On a reconnect partway through the pause, skip the entrance delay so the result shows at once.
  const revealDelayMs = useMemo(() => {
    const initial = msUntil(nextRoundAt, serverOffsetMs);
    if (initial === null) return DEFAULT_REVEAL_DELAY_MS;
    return Math.max(0, Math.min(DEFAULT_REVEAL_DELAY_MS, initial - RESULTS_VISIBLE_MS));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const revealDelay = revealDelayMs / 1000;
  const owners = tenOwnership(result);
  const uncaptured = owners ? ALL_TENS.filter((card) => owners[card] === null) : [];
  const myTeam = !spectator && mySeat !== null && mySeat !== undefined ? mySeat % 2 : null;
  const won = myTeam !== null && result.winner_team === myTeam;
  const lost = myTeam !== null && !won;
  const special = result.type !== "normal";
  const nextDealer = players.find((p) => p.seat === result.next_dealer);
  const seconds = remaining === null ? null : Math.ceil(remaining / 1000);
  const progress = remaining === null ? null : Math.max(0, Math.min(1, remaining / RESULTS_VISIBLE_MS));

  const lastTick = useRef(null);
  useEffect(() => {
    if (seconds !== null && seconds > 0 && seconds <= 3 && lastTick.current !== seconds) {
      lastTick.current = seconds;
      sound.play("tick", { gain: 0.6 });
    }
  }, [seconds]);
  useEffect(() => {
    if (!owners) return undefined;
    const timers = ALL_TENS.filter((card) => owners[card] !== null).map((card, i) =>
      setTimeout(() => sound.play("ten", { gain: 0.45 }), revealDelayMs + 550 + i * 180));
    return () => timers.forEach(clearTimeout);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const tone = ROUND_TONE[result.type] || ROUND_TONE.normal;
  const headline = spectator ? `${TEAM_NAME[result.winner_team]} wins the round` : won ? "Victory" : "Defeat";
  return (
    <motion.div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 p-2 backdrop-blur-sm sm:p-4"
      data-testid="round-result-modal" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: revealDelay, duration: 0.3 }}>
      <motion.div role="dialog" aria-modal="true" aria-labelledby="round-result-title"
        initial={{ opacity: 0, y: 26, scale: 0.95 }} animate={lost && special ? { opacity: 1, y: 0, scale: 1, x: [0, -6, 6, -3, 0] } : { opacity: 1, y: 0, scale: 1 }}
        transition={{ delay: revealDelay, duration: 0.5, ease: "easeOut" }}
        className={`relative w-full max-w-2xl max-h-[94vh] overflow-y-auto rounded-3xl border-2 bg-gradient-to-b from-[#123326] via-[#0a1f18] to-[#06110d] p-4 text-white shadow-[0_30px_80px_-20px_rgba(0,0,0,.95),inset_0_1px_0_rgba(251,191,36,.18)] sm:p-6 ${
          won ? "border-amber-300/55" : lost ? "border-rose-300/30" : "border-amber-200/30"}`}>
        <div className={`pointer-events-none absolute inset-0 rounded-3xl ${won ? "bg-[radial-gradient(ellipse_at_top,rgba(251,191,36,.2),transparent_60%)]" : lost ? "bg-[radial-gradient(ellipse_at_top,rgba(244,63,94,.12),transparent_60%)]" : "bg-[radial-gradient(ellipse_at_top,rgba(251,191,36,.12),transparent_60%)]"}`} aria-hidden />
        {won && <Burst count={special ? 36 : 22} />}

        <header className="relative text-center">
          <p className="eyebrow !text-amber-200/70" data-testid="round-result-round">Round {round} complete</p>
          {/* Medal: coloured by how the round was won for the winners and spectators; a steel shield for a defeat. */}
          <motion.div className={`relative mx-auto mt-2 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br ring-4 shadow-[0_10px_26px_-8px_rgba(0,0,0,.95),inset_0_2px_0_rgba(255,255,255,.45)] sm:h-[72px] sm:w-[72px] ${
            won || spectator ? `${tone.medal} ${tone.ring}` : "from-slate-300 via-slate-500 to-slate-800 ring-slate-300/25"}`}
            initial={{ scale: 0.4, rotate: -20, opacity: 0 }} animate={{ scale: 1, rotate: 0, opacity: 1 }}
            transition={{ delay: revealDelay + 0.15, type: "spring", stiffness: 260, damping: 14 }} aria-hidden="true">
            <span className="absolute inset-1.5 rounded-full border border-white/30" />
            {won || spectator ? <tone.Icon className="text-slate-950" size={28} strokeWidth={2.2} /> : <Shield className="text-slate-950/80" size={26} strokeWidth={2.2} />}
          </motion.div>
          <h2 id="round-result-title" className={`mt-2 bg-clip-text font-display text-3xl text-transparent sm:text-4xl ${won
            ? "bg-gradient-to-b from-amber-50 via-amber-200 to-amber-400" : lost ? "bg-gradient-to-b from-rose-50 via-rose-200 to-rose-400" : "bg-gradient-to-b from-amber-50 to-amber-200"}`}
            data-testid="round-result-headline">{headline}</h2>
          <p className="mt-2 flex flex-wrap items-center justify-center gap-1.5 text-sm text-white/85" data-testid="round-result-type">
            <span>{TEAM_NAME[result.winner_team]}</span>
            <span className="text-white/35"> · </span>
            <span className={`rounded-full border px-2 py-px text-xs font-bold ${tone.chip}`}>{VICTORY_LABEL[result.type] || result.type}</span>
          </p>
          <p className="mt-1 text-xs text-white/60" data-testid="round-result-reason">{reasonText(result)}</p>
          <div className="mt-3 inline-flex items-center gap-2.5 rounded-full border border-amber-300/50 bg-gradient-to-r from-amber-400/15 via-amber-300/10 to-transparent py-1 pl-1 pr-3.5 shadow-[0_0_24px_-10px_rgba(251,191,36,.6)]">
            <span className="flex h-8 min-w-8 items-center justify-center rounded-full bg-gradient-to-br from-amber-100 via-amber-300 to-amber-600 px-1.5 font-mono text-base font-black text-slate-950 shadow-[inset_0_2px_0_rgba(255,255,255,.5)]" data-testid="round-result-points">+{result.points}</span>
            <span className="text-[10px] font-bold uppercase tracking-wider text-amber-100/80">point{result.points === 1 ? "" : "s"} to {TEAM_NAME[result.winner_team]}</span>
          </div>
        </header>

        <div className="relative mt-4 grid grid-cols-2 gap-2 sm:gap-4">
          {[0, 1].map((team) => (
            <TeamPanel key={team} team={team} result={result} owners={owners} players={players} mySeat={spectator ? null : mySeat} revealDelay={revealDelay} />
          ))}
        </div>

        {!spectator && (
          <RoundMedals medals={medals} eligible={medalsEligible} players={players} mySeat={mySeat} revealDelay={revealDelay} />
        )}

        {owners === null && (
          <p className="relative mt-3 text-center text-[11px] text-white/45" data-testid="round-result-tens-unavailable">
            Individual ten cards were not recorded for this round.
          </p>
        )}
        {uncaptured.length > 0 && (
          <div className="relative mt-3 flex flex-wrap items-center justify-center gap-2 rounded-xl border border-dashed border-white/10 bg-black/20 px-3 py-2" data-testid="round-result-uncaptured">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-white/45">Still in play · not captured</span>
            {uncaptured.map((card) => (
              <div key={card} data-testid={`round-ten-${card}`} data-owner="none" className="opacity-40 grayscale">
                <PlayingCard card={card} size="sm" />
              </div>
            ))}
          </div>
        )}

        <footer className="relative mt-4 grid grid-cols-3 items-center gap-2 rounded-2xl border border-amber-300/20 bg-gradient-to-b from-black/30 to-black/45 px-3 py-3 text-center shadow-[inset_0_1px_0_rgba(251,191,36,.1)]">
          <div className="min-w-0">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-white/45">Match score</div>
            <div className="font-mono text-xl font-bold" data-testid="round-result-score">
              <span className={result.winner_team === 0 ? "text-amber-200" : "text-sky-200"}>{scores[0]}</span>
              <span className="text-white/40"> – </span>
              <span className={result.winner_team === 1 ? "text-amber-200" : "text-white/80"}>{scores[1]}</span>
            </div>
            {target ? (
              <div className="mx-auto mt-1 grid max-w-[110px] grid-cols-2 gap-1" aria-hidden="true" data-testid="round-result-race">
                {[0, 1].map((team) => (
                  <div key={team} className="h-1 overflow-hidden rounded-full bg-white/10">
                    <div className={`h-full rounded-full bg-gradient-to-r ${TEAM_TONE[team].bar}`} style={{ width: `${Math.min(100, ((scores[team] || 0) / target) * 100)}%` }} />
                  </div>
                ))}
              </div>
            ) : null}
            {target ? <div className="mt-0.5 text-[9px] text-white/40">first to {target}</div> : null}
          </div>
          <div className="min-w-0">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-white/45">Next dealer</div>
            <div className="mt-0.5 flex items-center justify-center gap-1.5">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-amber-200 to-amber-500 text-[10px] font-black text-slate-950" aria-hidden="true">D</span>
              <span className="truncate text-sm font-semibold" data-testid="round-result-next-dealer">{nextDealer ? (nextDealer.display_name || nextDealer.username) : "—"}</span>
            </div>
          </div>
          <div data-testid="round-result-countdown">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-white/45">Next round</div>
            <div className={`font-mono text-xl font-bold ${seconds !== null && seconds <= 3 ? "text-amber-300" : "text-amber-100"}`} data-testid="round-result-seconds">{seconds === null ? "soon" : `${seconds}s`}</div>
          </div>
          {progress !== null && (
            <div className="col-span-3 mt-1 h-1.5 overflow-hidden rounded-full bg-white/10" role="progressbar"
              aria-label="Time until the next round" aria-valuemin={0} aria-valuemax={10} aria-valuenow={seconds ?? 0}>
              <div className="h-full rounded-full bg-gradient-to-r from-amber-500 to-amber-200 transition-[width] duration-100 ease-linear"
                style={{ width: `${progress * 100}%` }} data-testid="round-result-progress" />
            </div>
          )}
        </footer>
      </motion.div>
    </motion.div>
  );
}
