import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { Trophy, Flag } from "lucide-react";
import { PlayingCard } from "@/components/PlayingCard";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { SUIT_SYMBOL, SUIT_NAME, TEAM_NAME, VICTORY_LABEL, REASON_LABEL, isRed } from "@/lib/api";

function Modal({ children, testId }) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm p-4" data-testid={testId}>
      <motion.div initial={{ opacity: 0, y: 24, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }}
        className="w-full max-w-md rounded-2xl border border-amber-400/30 bg-[#0d1626]/95 text-white p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
        {children}
      </motion.div>
    </div>
  );
}

export function Banner({ children, testId }) {
  return (
    <div className="absolute left-1/2 top-[42%] -translate-x-1/2 -translate-y-1/2 z-40 rounded-xl bg-black/65 backdrop-blur px-5 py-3 text-sm text-white text-center max-w-[80%]" data-testid={testId}>
      {children}
    </div>
  );
}

export function TrumpSelector({ onPick }) {
  return (
    <div className="absolute left-1/2 top-[42%] -translate-x-1/2 -translate-y-1/2 z-50 rounded-2xl border border-amber-400/40 bg-[#0d1626]/95 p-5 text-white text-center shadow-2xl" data-testid="trump-suit-selector">
      <p className="eyebrow !text-amber-200/80">You choose trump</p>
      <p className="text-xs text-white/60 mt-1">Based on your first five cards — any suit is allowed.</p>
      <div className="grid grid-cols-4 gap-2 mt-4">
        {["S", "H", "D", "C"].map((s) => (
          <button key={s} onClick={() => onPick(s)} data-testid={`trump-option-${s}`}
            className="h-16 w-16 rounded-xl bg-white hover:-translate-y-1 hover:shadow-amber-400/40 hover:shadow-lg transition-transform flex flex-col items-center justify-center">
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

export function GrandSlamPrompt({ partnerHand, onDecide }) {
  return (
    <Modal testId="grand-slam-decision-modal">
      <p className="eyebrow !text-amber-200/80">Seven tricks in a row</p>
      <h2 className="font-display text-2xl mt-2">Go for 13 Mann?</h2>
      <p className="text-sm text-white/70 mt-3">Declare Grand Slam and your team must win all six remaining tricks for <b>3 points</b>. Lose one and the opponents get the Grand Slam. It replaces any active Koth.</p>
      <div className="mt-4">
        <div className="text-xs text-white/60 mb-2">Your partner's remaining cards (shown once):</div>
        <div className="flex flex-wrap gap-1" data-testid="partner-hand-reveal">
          {(partnerHand || []).map((c) => <PlayingCard key={c} card={c} size="sm" testId={`partner-card-${c}`} />)}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 mt-6">
        <button className="btn-ghost !bg-white/5 !border-white/15 text-white" onClick={() => onDecide(false)} data-testid="grand-slam-decline-btn">Decline</button>
        <button className="btn-gold" onClick={() => onDecide(true)} data-testid="grand-slam-declare-btn">Declare Grand Slam</button>
      </div>
    </Modal>
  );
}

export function RoundResult({ result, mySeat, players }) {
  const [left, setLeft] = useState(7);
  useEffect(() => {
    const t = setInterval(() => setLeft((x) => Math.max(0, x - 1)), 1000);
    return () => clearInterval(t);
  }, []);
  const won = result.winner_team === mySeat % 2;
  const nd = players.find((p) => p.seat === result.next_dealer);
  return (
    <Modal testId="round-result-modal">
      <p className={`eyebrow ${won ? "!text-emerald-300" : "!text-rose-300"}`}>{won ? "Your team wins the round" : "Round lost"}</p>
      <h2 className="font-display text-2xl mt-2" data-testid="round-result-type">{TEAM_NAME[result.winner_team]} · {VICTORY_LABEL[result.type]}</h2>
      <p className="text-sm text-white/70 mt-2">{REASON_LABEL[result.reason]}</p>
      <div className="mt-4 grid grid-cols-3 gap-3 text-center">
        <div><div className="font-mono text-2xl text-amber-300" data-testid="round-result-points">+{result.points}</div><div className="text-[10px] uppercase text-white/50">points</div></div>
        <div><div className="font-mono text-2xl">{result.tens[0]}–{result.tens[1]}</div><div className="text-[10px] uppercase text-white/50">tens A–B</div></div>
        <div><div className="font-mono text-2xl">{result.tricks_won[0]}–{result.tricks_won[1]}</div><div className="text-[10px] uppercase text-white/50">tricks A–B</div></div>
      </div>
      <p className="text-xs text-white/60 mt-5 text-center">Next dealer: <b className="text-white">{nd?.username}</b> · next round in {left}s</p>
    </Modal>
  );
}

export function MatchOver({ st, players, mySeat }) {
  const wt = st.winner_team;
  const last = st.rounds[st.rounds.length - 1];
  const won = wt === mySeat % 2;
  const typeCount = (team, type) => st.rounds.filter((r) => r.winner_team === team && r.type === type).length;
  const forfeiter = st.forfeited_by !== null && st.forfeited_by !== undefined ? players.find((p) => p.seat === st.forfeited_by) : null;
  return (
    <Modal testId="victory-screen">
      <div className="text-center">
        {won ? <Trophy className="mx-auto text-amber-300" size={40} /> : <Flag className="mx-auto text-rose-300" size={36} />}
        <p className="eyebrow mt-3 !text-amber-200/80">{won ? "Victory" : "Defeat"}</p>
        <h2 className="font-display text-3xl mt-1" data-testid="victory-winning-team">{TEAM_NAME[wt]} wins the match</h2>
        <p className="text-sm text-white/70 mt-2" data-testid="victory-type">
          {forfeiter ? `${forfeiter.username} forfeited the match` : last ? `Final round: ${VICTORY_LABEL[last.type]} (+${last.points})` : ""}
        </p>
        <div className="font-mono text-4xl mt-4" data-testid="victory-final-score">
          <span className="text-team-a">{st.scores[0]}</span> <span className="text-white/40">–</span> <span className="text-team-b">{st.scores[1]}</span>
        </div>
      </div>
      <div className="mt-6 space-y-2">
        {[0, 1].map((t) => (
          <div key={t} className="rounded-xl bg-white/5 p-3">
            <div className={`text-xs font-bold uppercase tracking-wider ${t === 0 ? "text-team-a" : "text-team-b"}`}>{TEAM_NAME[t]}</div>
            <div className="flex gap-3 mt-2">
              {players.filter((p) => p.team === t).map((p) => (
                <div key={p.seat} className="flex items-center gap-2 text-sm"><PlayerAvatar user={p} size={26} />{p.username}</div>
              ))}
            </div>
            <div className="text-xs text-white/60 mt-2">Normal {typeCount(t, "normal")} · Koth {typeCount(t, "koth")} · Grand Slam {typeCount(t, "grand_slam")}</div>
          </div>
        ))}
      </div>
      <div className="text-xs text-white/50 mt-3">{st.rounds.length} round{st.rounds.length === 1 ? "" : "s"} played</div>
      <div className="grid grid-cols-2 gap-3 mt-6">
        <Link to="/history" className="btn-ghost !bg-white/5 !border-white/15 text-white" data-testid="victory-history-btn">Match history</Link>
        <Link to="/home" className="btn-gold" data-testid="victory-home-btn">Back to home</Link>
      </div>
    </Modal>
  );
}
