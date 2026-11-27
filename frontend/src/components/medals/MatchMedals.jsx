import { motion } from "framer-motion";
import { Bot, Medal } from "lucide-react";
import { medalSummary, netChange, signed, victoryName } from "@/components/medals/medalText";

// Medal changes over the whole match, exactly as the server stored them (backend/medals.py): your net
// change and new lifetime balance, your change in every round, and each player's net for the match.
export function MatchMedals({ summary, eligible, players = [], mySeat }) {
  if (eligible === false) {
    return (
      <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-white/45" data-testid="match-medals-unavailable">
        <Bot size={13} aria-hidden="true" /> No medals in matches with bots.
      </p>
    );
  }
  if (!summary?.eligible || !Array.isArray(summary.rounds) || summary.rounds.length === 0) return null;
  const me = players.find((p) => p.seat === mySeat);
  const myId = me?.user_id;
  const myRounds = summary.rounds
    .map((r) => ({ round: r, mine: r.players?.find((p) => p.user_id === myId) }))
    .filter((x) => x.mine);
  const myNet = myRounds.reduce((sum, x) => sum + netChange(x.mine), 0);
  const balance = [...myRounds].reverse().find((x) => x.mine.balance_after !== null && x.mine.balance_after !== undefined)?.mine.balance_after;
  const total = (uid) => Number(summary.totals?.[uid]) || 0;
  const ordered = [...players].sort((a, b) => a.team - b.team || a.seat - b.seat);
  const tone = (n) => (n > 0 ? "text-orange-200" : n < 0 ? "text-rose-200" : "text-white/45");

  return (
    <motion.section className="mt-4 rounded-2xl border border-orange-300/25 bg-gradient-to-br from-orange-300/[0.09] via-black/20 to-black/30 p-3 sm:p-4" data-testid="match-medals-summary"
      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5, duration: 0.35 }}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-orange-200/85"><Medal size={13} aria-hidden="true" /> Medals this match</span>
        {myId && (
          <span className="inline-flex items-center gap-2" data-testid="match-medals-mine">
            <motion.span className={`rounded-full px-2.5 py-0.5 font-mono text-base font-black ${myNet > 0 ? "bg-gradient-to-br from-amber-100 via-amber-300 to-orange-500 text-slate-950" : myNet < 0 ? "bg-rose-500/20 text-rose-200" : "bg-white/10 text-white/60"}`}
              initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.8, type: "spring", stiffness: 300, damping: 15 }}
              data-testid="match-medals-net">{signed(myNet)}</motion.span>
            {balance !== undefined && <span className="text-xs text-white/60">balance <b className="font-mono text-orange-200" data-testid="match-medals-balance">{Number(balance).toLocaleString("en-IN")}</b></span>}
          </span>
        )}
      </div>

      {myRounds.length > 0 && (
        <ol className="mt-2 flex flex-wrap gap-1.5" data-testid="match-medals-rounds" aria-label="Your medal change in each round">
          {myRounds.map(({ round, mine }) => (
            <li key={round.round} className={`rounded-lg border px-2 py-0.5 text-[11px] ${mine.won === false ? "border-rose-300/25 bg-rose-950/25" : "border-orange-300/25 bg-orange-300/[0.07]"}`}
              title={`Round ${round.round} · ${victoryName(round.type)} ${mine.won === false ? "loss" : "win"}: ${medalSummary(mine, round.type)}`} data-testid={`match-medals-round-${round.round}`}>
              <span className="text-white/45">R{round.round} </span>
              <b className={`font-mono ${tone(netChange(mine))}`}>{signed(netChange(mine))}</b>
            </li>
          ))}
        </ol>
      )}

      <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-4" data-testid="match-medals-players">
        {ordered.map((p) => (
          <div key={p.seat} className={`min-w-0 rounded-xl border px-2 py-1 ${p.seat === mySeat ? "border-orange-200/50 bg-orange-300/10" : "border-white/10 bg-black/20"}`}>
            <div className="truncate text-[11px] text-white/70">{p.display_name || p.username}{p.seat === mySeat ? " (you)" : ""}</div>
            <div className={`font-mono text-sm font-bold ${tone(total(p.user_id))}`} data-testid={`match-medals-player-${p.seat}`}>{signed(total(p.user_id))}</div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[10px] text-white/35">Win: 1 per trick, +3 per ten, + bonus (Normal 1 · Koth 4 · Grand Slam 13). Loss: minus the same bonus, never below 0.</p>
    </motion.section>
  );
}
