import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CardBack, PlayingCard } from "@/components/PlayingCard";
import { SUIT_SYMBOL, isRed } from "@/lib/api";
import { relOf } from "@/components/game/TableLayout";
import { TEN_FLIGHT_MS, TEN_LAND_MS, TEN_STAGGER_MS, TRICK_BURST_MS } from "@/hooks/useTableEffects";

const TARGET = [{ x: 0, y: "40vh" }, { x: "40vw", y: 0 }, { x: 0, y: "-28vh" }, { x: "-40vw", y: 0 }];

export function DealLayer({ flying, mySeat, dealing }) {
  return (
    <div className="absolute left-1/2 top-1/2 z-30 pointer-events-none" data-testid="deal-layer">
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

const POP = 0.45;                                         // seconds the ten spends popping in the centre
const ARC = TEN_LAND_MS / 1000 - POP;                     // seconds of the arc to the tens counter
const LABEL = (TEN_FLIGHT_MS - TEN_LAND_MS) / 1000 - 0.05; // "+1 ten" label, finishing before removal
const TONE = {
  mine: { glow: "rgba(251,191,36,.9)", ring: "#fbbf24", spark: ["#fde68a", "#fbbf24", "#ffffff"], label: "from-amber-200 to-amber-400 text-slate-950" },
  theirs: { glow: "rgba(244,114,182,.75)", ring: "#fb7185", spark: ["#fecdd3", "#fb7185", "#ffffff"], label: "from-rose-300 to-rose-500 text-white" },
};

function Sparks({ colors, count = 14, spread = 70, delay = 0, size = 6 }) {
  return Array.from({ length: count }).map((_, i) => {
    const a = (i / count) * Math.PI * 2 + (i % 2 ? 0.2 : 0);
    const d = spread * (0.7 + ((i * 37) % 10) / 22);
    return (
      <motion.span key={i} className="absolute left-0 top-0 rounded-full" aria-hidden="true"
        style={{ width: size, height: size, marginLeft: -size / 2, marginTop: -size / 2, background: colors[i % colors.length], boxShadow: `0 0 8px ${colors[1]}` }}
        initial={{ x: 0, y: 0, opacity: 0, scale: 0.4 }}
        animate={{ x: Math.cos(a) * d, y: Math.sin(a) * d, opacity: [0, 1, 0], scale: [0.4, 1.1, 0.3] }}
        transition={{ delay, duration: 0.75, ease: "easeOut", times: [0, 0.25, 1] }} />
    );
  });
}

function Shockwave({ color, delay = 0, to = 2.8, width = 3 }) {
  return (
    <motion.span className="absolute left-0 top-0 h-16 w-16 -ml-8 -mt-8 rounded-full" aria-hidden="true"
      style={{ border: `${width}px solid ${color}`, boxShadow: `0 0 18px ${color}` }}
      initial={{ scale: 0.3, opacity: 0.95 }} animate={{ scale: to, opacity: 0 }}
      transition={{ delay, duration: 0.6, ease: "easeOut" }} />
  );
}

// A captured ten: it pops in the trick area (shockwave, sparks, light rays), arcs to the winning team's
// tens counter with a glowing trail, and lands with a burst and a "+1 ten" label. Timings come from
// TEN_LAND_MS / TEN_FLIGHT_MS so the landing sound (useTableEffects) matches the landing.
function TenFlight({ card, team, mine = true, order = 0 }) {
  const [to, setTo] = useState(null);
  useEffect(() => {
    const r = document.querySelector(`[data-testid=tens-counter-team-${team === 0 ? "a" : "b"}]`)?.getBoundingClientRect();
    const c = document.querySelector("[data-testid=center-trick-area]")?.getBoundingClientRect();
    const sx = c ? c.left + c.width / 2 : window.innerWidth / 2, sy = c ? c.top + c.height / 2 : window.innerHeight / 2;
    setTo({ sx, sy, x: r ? r.left + r.width / 2 - sx : -300, y: r ? r.top + r.height / 2 - sy : -300 });
  }, [team]);
  if (!to) return null;
  const t = mine ? TONE.mine : TONE.theirs;
  const wait = (order * TEN_STAGGER_MS) / 1000;
  const total = POP + ARC;
  const pop = POP / total;
  // Curved path: lift above the straight line, more for longer trips.
  const lift = Math.min(140, 40 + Math.hypot(to.x, to.y) * 0.25);
  const mid = { x: to.x * 0.5 + (to.x === 0 ? 60 : 0), y: Math.min(0, to.y) * 0.5 - lift };
  const landing = { left: to.sx + to.x, top: to.sy + to.y };
  // The "+1 ten" label is centred on the counter but kept on screen (Team B's counter sits at the right edge).
  const labelLeft = Math.min(Math.max(landing.left, 40), window.innerWidth - 40);
  // It floats up about 34px, so start it low enough to stay on screen under a slim landscape header.
  const labelTop = Math.max(landing.top, 40);
  return (
    <div className="pointer-events-none" data-testid={`ten-flight-${card}`} data-mine={mine ? "true" : "false"}>
      {/* Pop in the centre: light rays, shockwave and sparks behind the card. */}
      <div className="fixed z-50" style={{ left: to.sx, top: to.sy }}>
        <motion.span className="absolute left-0 top-0 h-40 w-40 -ml-20 -mt-20 rounded-full" aria-hidden="true"
          style={{ background: `conic-gradient(from 0deg, transparent 0 10%, ${t.glow} 12%, transparent 14% 35%, ${t.glow} 37%, transparent 39% 60%, ${t.glow} 62%, transparent 64% 85%, ${t.glow} 87%, transparent 89%)`, filter: "blur(3px)" }}
          initial={{ opacity: 0, scale: 0.4, rotate: 0 }} animate={{ opacity: [0, 0.55, 0], scale: [0.4, 1.1, 1.3], rotate: 70 }}
          transition={{ delay: wait, duration: POP + 0.35, ease: "easeOut" }} />
        <Shockwave color={t.ring} delay={wait + 0.05} />
        <Sparks colors={t.spark} delay={wait + 0.06} spread={mine ? 80 : 60} count={mine ? 16 : 10} />
      </div>
      {/* Glowing trail following the card along the arc. */}
      {[0.06, 0.12, 0.18].map((lag, i) => (
        <motion.span key={lag} className="fixed z-50 h-3 w-3 -ml-1.5 -mt-1.5 rounded-full" aria-hidden="true"
          style={{ left: to.sx, top: to.sy, background: t.spark[i % 2], boxShadow: `0 0 12px ${t.glow}` }}
          initial={{ x: 0, y: 0, opacity: 0 }}
          animate={{ x: [0, 0, mid.x, to.x], y: [0, -8, mid.y, to.y], opacity: [0, 0, 0.8 - i * 0.2, 0] }}
          transition={{ delay: wait + lag, duration: total, times: [0, pop, pop + (1 - pop) / 2, 1], ease: "easeInOut" }} />
      ))}
      {/* The card itself: pop with a wobble, then arc and shrink onto the counter. */}
      <motion.div className="fixed z-50 -ml-7 -mt-10 sm:-ml-8 sm:-mt-[45px]" style={{ left: to.sx, top: to.sy }}
        initial={{ x: 0, y: 0, scale: 1, rotate: 0, opacity: 0 }}
        animate={{
          x: [0, 0, 0, mid.x, to.x], y: [0, -10, -8, mid.y, to.y],
          scale: [1, 1.5, 1.4, 0.8, 0.3], rotate: [0, -6, 4, 12, 0], opacity: [1, 1, 1, 1, 0.85],
        }}
        transition={{ delay: wait, duration: total, times: [0, pop * 0.45, pop, pop + (1 - pop) / 2, 1], ease: "easeInOut" }}>
        <PlayingCard card={card} size="md" testId={`ten-flight-card-${card}`}
          style={{ boxShadow: `0 0 0 4px ${t.ring}, 0 0 34px ${t.glow}, 0 14px 30px -10px rgba(0,0,0,.8)` }} />
      </motion.div>
      {/* Landing on the tens counter: burst, sparks and a "+1 ten" label floating up. */}
      <div className="fixed z-50" style={landing}>
        <Shockwave color={t.ring} delay={wait + total - 0.02} to={1.6} width={2} />
        <Sparks colors={t.spark} delay={wait + total} spread={34} count={10} size={4} />
      </div>
      <div className="fixed z-50" style={{ left: labelLeft, top: labelTop }}>
        <motion.span style={{ x: "-50%" }} className={`absolute left-0 top-0 whitespace-nowrap rounded-full bg-gradient-to-r px-2 py-0.5 text-[10px] font-black uppercase tracking-wider shadow-[0_6px_14px_-4px_rgba(0,0,0,.9)] ${t.label}`}
          data-testid={`ten-landing-${card}`}
          initial={{ opacity: 0, y: 6, scale: 0.7 }} animate={{ opacity: [0, 1, 1, 0], y: [6, -18, -26, -34], scale: [0.7, 1.1, 1, 0.95] }}
          transition={{ delay: wait + total, duration: LABEL, times: [0, 0.2, 0.7, 1] }}>
          +1 ten
        </motion.span>
      </div>
    </div>
  );
}

// A won trick arriving at the winner's seat: a ring and a few sparks around the seat panel and a "+1 trick"
// label rising above it. Smaller than the ten effect: tricks are won 13 times a round.
export function TrickWinBurst({ win }) {
  const [at, setAt] = useState(null);
  useEffect(() => {
    if (!win) { setAt(null); return; }
    const r = document.querySelector(`[data-testid="player-seat-${win.seat}"]`)?.getBoundingClientRect();
    if (!r) { setAt(null); return; }
    setAt({ x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top });
  }, [win]);
  if (!win || !at) return null;
  const t = win.mine ? TONE.mine : TONE.theirs;
  const labelLeft = Math.min(Math.max(at.x, 44), window.innerWidth - 44);
  const labelTop = Math.max(at.top - 6, 40);
  return (
    <div className="pointer-events-none" key={win.id} data-testid="trick-win-burst" data-seat={win.seat} data-mine={win.mine ? "true" : "false"}>
      <div className="fixed z-40" style={{ left: at.x, top: at.y }}>
        <Shockwave color={t.ring} to={2.2} width={2} />
        <Sparks colors={t.spark} spread={win.mine ? 52 : 40} count={win.mine ? 10 : 6} size={4} />
      </div>
      <div className="fixed z-40" style={{ left: labelLeft, top: labelTop }}>
        <motion.span style={{ x: "-50%" }} className={`absolute left-0 top-0 whitespace-nowrap rounded-full bg-gradient-to-r px-2 py-0.5 text-[10px] font-black uppercase tracking-wider shadow-[0_6px_14px_-4px_rgba(0,0,0,.9)] ${t.label}`}
          initial={{ opacity: 0, y: 4, scale: 0.7 }} animate={{ opacity: [0, 1, 1, 0], y: [4, -14, -20, -26], scale: [0.7, 1.08, 1, 0.95] }}
          transition={{ duration: TRICK_BURST_MS / 1000 - 0.05, times: [0, 0.2, 0.7, 1] }}>
          +1 trick
        </motion.span>
      </div>
    </div>
  );
}

export function TenFlights({ flights }) {
  return flights.map((f) => <TenFlight key={f.id} card={f.card} team={f.team} mine={f.mine !== false} order={f.order || 0} />);
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
