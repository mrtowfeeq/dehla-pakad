import { motion, AnimatePresence } from "framer-motion";
import { WifiOff, Bot } from "lucide-react";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { CardBack, PlayingCard } from "@/components/PlayingCard";
import { TEAM_NAME } from "@/lib/api";

// rel position: 0 = me (bottom), 1 = my right (east), 2 = partner (top), 3 = my left (west)
export const relOf = (seat, mySeat) => (seat - mySeat + 4) % 4;
const SEAT_POS = [
  "bottom-[118px] sm:bottom-[190px] left-1/2 -translate-x-1/2",
  "right-2 sm:right-6 top-[42%] -translate-y-1/2",
  "top-[158px] sm:top-5 left-1/2 -translate-x-1/2",
  "left-2 sm:left-6 top-[42%] -translate-y-1/2",
];

export function Seat({ player, st, mySeat, reaction, pending = 0, highlight, dealing }) {
  const rel = relOf(player.seat, mySeat);
  const isTurn = st.turn === player.seat || (st.phase === "trump_select" && st.trump_selector === player.seat && !dealing);
  const team = player.team;
  const count = Math.max(0, st.hand_counts[player.seat] - pending);
  const deciding = (st.phase === "koth_decision" && st.koth_decision === team) || (st.phase === "gs_decision" && st.gs_eligible === team);
  const thinking = rel !== 0 && (isTurn || deciding) && ["playing", "trump_select", "koth_decision", "gs_decision"].includes(st.phase);
  return (
    <div className={`absolute z-20 ${SEAT_POS[rel]} flex ${rel === 0 ? "flex-row" : "flex-col"} items-center gap-2`} data-testid={`player-seat-${player.seat}`}>
      <div className="relative">
        <motion.div animate={highlight ? { scale: [1, 1.18, 1.08] } : { scale: 1 }} transition={{ duration: 0.5 }}
          className={`rounded-full ${highlight ? "shadow-[0_0_28px_8px_rgba(251,191,36,.55)]" : ""} ${!player.online ? "grayscale opacity-60" : ""} transition-[filter,opacity] duration-500`}>
          <PlayerAvatar user={player} size={rel === 0 ? 40 : 48}
            ring={`ring-[3px] ${team === 0 ? "ring-team-a" : "ring-team-b"} ${isTurn ? "turn-pulse" : ""}`} />
        </motion.div>
        {st.dealer === player.seat && (
          <span className="absolute -top-1.5 -left-1.5 h-5 w-5 rounded-full bg-amber-400 text-slate-950 text-[10px] font-black flex items-center justify-center shadow" data-testid={`dealer-badge-${player.seat}`}>D</span>
        )}
        {!player.online && (
          <span className="absolute -bottom-1 -right-1 h-5 w-5 rounded-full bg-rose-600 flex items-center justify-center" title="Disconnected" data-testid={`offline-badge-${player.seat}`}>
            <WifiOff size={11} className="text-white" />
          </span>
        )}
        <AnimatePresence>
          {reaction && (
            <motion.div key={reaction.id} initial={{ opacity: 0, y: 6, scale: 0.6 }} animate={{ opacity: 1, y: -30, scale: 1.2 }} exit={{ opacity: 0 }}
              className="absolute left-1/2 -translate-x-1/2 -top-2 text-3xl pointer-events-none" data-testid={`seat-reaction-${player.seat}`}>{reaction.emoji}</motion.div>
          )}
        </AnimatePresence>
      </div>
      <div className={`rounded-lg bg-black/55 backdrop-blur px-2.5 py-1 text-center ${isTurn ? "ring-1 ring-amber-300/70" : ""}`}>
        <div className="text-xs sm:text-sm font-semibold text-white max-w-[96px] sm:max-w-[130px] truncate">{rel === 0 ? "You" : player.username}</div>
        <div className={`text-[10px] font-bold uppercase tracking-wider ${team === 0 ? "text-team-a" : "text-team-b"}`}>
          {TEAM_NAME[team]}{rel === 2 ? " · Partner" : ""}
        </div>
        {player.is_bot && <div className="text-[10px] text-white/60 inline-flex items-center gap-1" data-testid={`bot-badge-${player.seat}`}><Bot size={10} /> Bot</div>}
        {!player.online && <div className="text-[10px] text-rose-300">Reconnecting…</div>}
        {thinking && (
          <div className="flex items-center justify-center gap-1 text-[10px] text-amber-200/90 mt-0.5" data-testid={`thinking-indicator-${player.seat}`}>
            <span className="thinking-dot" /><span className="thinking-dot" style={{ animationDelay: ".15s" }} /><span className="thinking-dot" style={{ animationDelay: ".3s" }} />
            <span className="ml-1">{player.is_bot ? "Bot thinking" : "Thinking"}</span>
          </div>
        )}
      </div>
      {rel !== 0 && (
        <div className="hidden sm:flex items-center" data-testid={`seat-card-count-${player.seat}`}>
          {Array.from({ length: Math.min(count, 6) }).map((_, i) => <CardBack key={i} size="xs" className={i ? "-ml-6" : ""} />)}
          <span className="ml-2 font-mono text-xs text-white/80">{count}</span>
        </div>
      )}
      {rel !== 0 && <span className="sm:hidden font-mono text-[10px] text-white/70">{count} cards</span>}
    </div>
  );
}

const OFFSET = [{ x: 0, y: 46 }, { x: 62, y: 0 }, { x: 0, y: -46 }, { x: -62, y: 0 }];
const FROM = [{ x: 0, y: 260 }, { x: 300, y: 0 }, { x: 0, y: -260 }, { x: -300, y: 0 }];

export function TrickArea({ cards, mySeat, winner }) {
  return (
    <div className="absolute left-1/2 top-[47%] sm:top-[42%] -translate-x-1/2 -translate-y-1/2 w-60 h-56 sm:w-72 sm:h-64 z-10" data-testid="center-trick-area">
      <div className="absolute inset-6 rounded-full border border-amber-200/10" />
      <AnimatePresence>
        {cards.map(([seat, card], i) => {
          const rel = relOf(seat, mySeat);
          const toW = winner !== undefined && winner !== null ? OFFSET[relOf(winner, mySeat)] : null;
          return (
            <motion.div key={`${seat}-${card}`} className="absolute left-1/2 top-1/2" style={{ zIndex: i + 1, marginLeft: -32, marginTop: -46 }}
              initial={{ ...FROM[rel], opacity: 0, rotate: rel * 8 - 12 }}
              animate={{ ...OFFSET[rel], opacity: winner !== null && winner !== undefined && winner !== seat ? 0.8 : 1, rotate: (rel - 1.5) * 5 + ((seat * 7) % 5) - 2, scale: winner === seat ? 1.1 : 1 }}
              exit={toW ? { x: toW.x * 4.5, y: toW.y * 4.5, opacity: 0, scale: 0.55, rotate: 0, transition: { duration: 0.45, ease: "easeIn" } } : { opacity: 0 }}
              transition={{ type: "spring", stiffness: 240, damping: 24 }}>
              <PlayingCard card={card} size="md" testId={`trick-card-${seat}`} className={winner === seat ? "ring-[3px] ring-amber-400 shadow-[0_0_26px_rgba(251,191,36,.7)]" : "shadow-[0_12px_22px_-8px_rgba(0,0,0,.75)]"} />
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
