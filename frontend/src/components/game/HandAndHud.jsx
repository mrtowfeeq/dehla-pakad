import { useRef, useState } from "react";
import { motion } from "framer-motion";
import { sound } from "@/lib/sound";
import { PlayingCard } from "@/components/PlayingCard";
import { SUIT_SYMBOL, SUIT_NAME, TEAM_NAME, isRed } from "@/lib/api";

export function Hand({ cards, legal, myTurn, onPlay, pending, onInvalid }) {
  const n = cards.length;
  const legalSet = new Set(legal);
  const [selected, setSelected] = useState(null);
  const [shake, setShake] = useState(null);
  const pointer = useRef("mouse");
  const tap = (c) => {
    if (!myTurn || pending) return;
    if (!legalSet.has(c)) {
      setShake(c); setTimeout(() => setShake(null), 320);
      sound.play("invalid");
      return onInvalid?.();
    }
    if (pointer.current !== "mouse" && selected !== c) { setSelected(c); sound.play("pickup", { gain: 0.7 }); return; }
    setSelected(null);
    sound.play("pickup", { gain: 0.6 });
    onPlay(c);
  };
  return (
    <div className="absolute bottom-3 sm:bottom-7 left-1/2 -translate-x-1/2 z-30 flex items-end justify-center w-full px-2" data-testid="player-hand-container">
      <div className="flex items-end justify-center">
        {cards.map((c, i) => {
          const playable = myTurn && legalSet.has(c) && !pending;
          const mid = (n - 1) / 2;
          const isSel = selected === c && playable;
          return (
            <motion.button key={c} type="button" data-sound="none" onPointerDown={(e) => { pointer.current = e.pointerType; }} onClick={() => tap(c)}
              data-testid={`hand-card-${c}`} data-selected={isSel ? "true" : "false"} aria-disabled={!playable}
              initial={{ y: -260, opacity: 0, rotate: -8, scale: 0.9 }}
              animate={{ y: isSel ? -26 : Math.abs(i - mid) * 2.2, opacity: 1, rotate: isSel ? 0 : (i - mid) * 2.6, scale: 1 }}
              exit={{ y: -120, opacity: 0 }}
              transition={{ type: "spring", stiffness: 210, damping: 22 }}
              whileHover={playable ? { y: -22 } : {}}
              className={`${i ? "-ml-[22px] sm:-ml-8 md:-ml-9" : ""} origin-bottom ${playable ? "cursor-pointer" : "cursor-default"} ${myTurn && !legalSet.has(c) ? "brightness-50" : ""} ${shake === c ? "shake" : ""}`}>
              <PlayingCard card={c} size="hand" className={isSel ? "ring-[3px] ring-amber-300 shadow-[0_0_22px_rgba(251,191,36,.6)]" : playable ? "ring-2 ring-amber-300/70" : ""} />
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}

export function TensRow({ tens, team, label }) {
  return (
    <motion.div key={tens.length} initial={tens.length ? { scale: 1.25 } : false} animate={{ scale: 1 }} transition={{ duration: 0.5, delay: 0.9 }}
      data-testid={`tens-counter-team-${team === 0 ? "a" : "b"}`} className="flex items-center gap-1.5 origin-left">
      <span className={`text-[10px] font-bold uppercase tracking-wider ${team === 0 ? "text-team-a" : "text-team-b"}`}>{label}</span>
      <span className="font-mono text-xs text-white/80" data-testid={`tens-count-team-${team === 0 ? "a" : "b"}`}>{tens.length}/4</span>
      <div className="flex gap-0.5">{tens.map((c) => <PlayingCard key={c} card={c} size="xs" testId={`captured-ten-${c}`} />)}</div>
    </motion.div>
  );
}

export function Scoreboard({ st, mySeat }) {
  const myTeam = mySeat % 2;
  return (
    <div className="rounded-xl border border-white/10 bg-black/45 backdrop-blur-md p-2.5 sm:p-3 text-white" data-testid="match-scoreboard">
      <div className="flex items-center gap-3 sm:gap-4 whitespace-nowrap">
        {[0, 1].map((t) => (
          <div key={t} className="min-w-[64px]">
            <div className={`text-[10px] font-bold uppercase tracking-wider ${t === 0 ? "text-team-a" : "text-team-b"}`}>{TEAM_NAME[t]}{t === myTeam ? " •" : ""}</div>
            <div className="font-mono text-2xl font-bold leading-none mt-0.5" data-testid={`score-team-${t === 0 ? "a" : "b"}`}>{st.scores[t]}<span className="text-xs text-white/50">/{st.target}</span></div>
            <div className="text-[10px] text-white/60 mt-0.5" data-testid={`tricks-team-${t === 0 ? "a" : "b"}`}>Tricks {st.tricks_won[t]}</div>
          </div>
        ))}
      </div>
      <div className="mt-2 pt-2 border-t border-white/10 space-y-1">
        <TensRow tens={st.tens[0]} team={0} label="A tens" />
        <TensRow tens={st.tens[1]} team={1} label="B tens" />
      </div>
    </div>
  );
}

export function TrumpBadge({ trump }) {
  return (
    <div data-testid="trump-indicator-badge" className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-amber-400/40 bg-black/60 shadow-lg text-amber-300 font-semibold text-sm">
      <span className="text-[10px] uppercase tracking-widest text-amber-200/70">Trump</span>
      {trump ? (
        <span className={`text-xl leading-none ${isRed(trump) ? "text-rose-400" : "text-white"}`} title={SUIT_NAME[trump]}>{SUIT_SYMBOL[trump]}</span>
      ) : <span className="text-white/60">—</span>}
    </div>
  );
}
