import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CardBack, PlayingCard } from "@/components/PlayingCard";
import { SUIT_SYMBOL, isRed } from "@/lib/api";
import { relOf } from "@/components/game/TableParts";

const TARGET = [{ x: 0, y: "40vh" }, { x: "40vw", y: 0 }, { x: 0, y: "-28vh" }, { x: "-40vw", y: 0 }];

export function DealLayer({ flying, mySeat, dealing }) {
  return (
    <div className="absolute left-1/2 top-[44%] sm:top-[42%] z-30 pointer-events-none" data-testid="deal-layer">
      <AnimatePresence>
        {dealing && (
          <motion.div key="deck" className="absolute -ml-[22px] -mt-8" initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.8 }} data-testid="deal-deck">
            {[0, 1, 2].map((i) => <CardBack key={i} size="sm" className="absolute" style={{ transform: `translate(${i * 1.5}px, ${-i * 1.5}px)` }} />)}
          </motion.div>
        )}
      </AnimatePresence>
      {flying.map((f) => {
        const rel = relOf(f.seat, mySeat);
        return (
          <motion.div key={f.id} className="absolute -ml-[22px] -mt-8" data-testid="dealing-card"
            initial={{ x: 0, y: 0, rotate: 0, opacity: 1 }}
            animate={{ ...TARGET[rel], rotate: (rel % 2 ? 90 : 0) + (Math.random() * 16 - 8), opacity: 0.95 }}
            transition={{ duration: 0.33, ease: [0.2, 0.7, 0.3, 1] }}>
            <CardBack size="sm" className="shadow-[0_10px_18px_-6px_rgba(0,0,0,.7)]" />
          </motion.div>
        );
      })}
    </div>
  );
}

function TenFlight({ card, team }) {
  const [to, setTo] = useState(null);
  useEffect(() => {
    const r = document.querySelector(`[data-testid=tens-counter-team-${team === 0 ? "a" : "b"}]`)?.getBoundingClientRect();
    setTo(r ? { x: r.right - 20 - window.innerWidth / 2, y: r.top + r.height / 2 - window.innerHeight * 0.42 } : { x: -300, y: -300 });
  }, [team]);
  if (!to) return null;
  return (
    <motion.div className="fixed left-1/2 top-[42%] z-50 pointer-events-none -ml-7 -mt-10" data-testid={`ten-flight-${card}`}
      initial={{ x: 0, y: 0, scale: 1.3, opacity: 1 }}
      animate={{ x: [0, 0, to.x], y: [0, -10, to.y], scale: [1.3, 1.35, 0.3], opacity: [1, 1, 0.3] }}
      transition={{ duration: 1, times: [0, 0.3, 1], ease: "easeInOut" }}>
      <PlayingCard card={card} size="md" testId={`ten-flight-card-${card}`} className="ring-4 ring-amber-300 shadow-[0_0_34px_rgba(251,191,36,.85)]" />
    </motion.div>
  );
}

export function TenFlights({ flights }) {
  return flights.map((f) => <TenFlight key={f.id} card={f.card} team={f.team} />);
}

export function Announcement({ a }) {
  return (
    <AnimatePresence>
      {a && (
        <motion.div key={a.id} className="absolute inset-x-0 top-[22%] z-[45] flex justify-center pointer-events-none" data-testid={`announcement-${a.kind}`}
          initial={{ opacity: 0, scale: 0.82, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 1.06 }}
          transition={{ type: "spring", stiffness: 220, damping: 20 }}>
          <div className={`relative px-8 py-4 rounded-2xl text-center backdrop-blur-sm ${a.kind === "gs" ? "bg-rose-950/45 border border-rose-300/30" : "bg-black/45 border border-amber-300/30"}`}>
            {a.kind !== "trump" && <div className="absolute inset-0 rounded-2xl announce-shine" />}
            <div className={`font-display font-bold tracking-[0.12em] ${a.kind === "trump" ? "text-xl sm:text-2xl text-white" : "text-2xl sm:text-4xl bg-gradient-to-r from-amber-200 via-amber-400 to-amber-200 bg-clip-text text-transparent"}`}>
              {a.kind === "trump" && <span className={`mr-2 ${isRed(a.suit) ? "text-rose-400" : "text-white"}`}>{SUIT_SYMBOL[a.suit]}</span>}
              {a.title}
            </div>
            {a.sub && <div className="text-xs sm:text-sm text-white/75 mt-1">{a.sub}</div>}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Burst({ color = "#fbbf24", count = 18 }) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-visible" aria-hidden>
      {Array.from({ length: count }).map((_, i) => {
        const a = (i / count) * Math.PI * 2;
        return (
          <motion.span key={i} className="absolute left-1/2 top-10 h-1.5 w-1.5 rounded-full" style={{ background: i % 3 ? color : "#fff" }}
            initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
            animate={{ x: Math.cos(a) * (90 + (i % 4) * 25), y: Math.sin(a) * (70 + (i % 3) * 20), opacity: 0, scale: 0.4 }}
            transition={{ duration: 1.3, ease: "easeOut", delay: 0.1 }} />
        );
      })}
    </div>
  );
}
