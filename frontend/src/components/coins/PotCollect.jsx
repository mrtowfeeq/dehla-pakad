import { useEffect, useLayoutEffect, useState } from "react";
import { motion } from "framer-motion";
import { CoinIcon, formatCoins } from "@/components/coins/Coins";
import { sound } from "@/lib/sound";
import { prefersReducedMotion } from "@/hooks/useTableEffects";

// Timeline (ms) of the stake collection played on the lobby table while the match countdown runs.
// It has to finish inside the 3-2-1 countdown (2.4 s): the game has already started on the server.
export const POT_TIMING = {
  firstLaunch: 150, // first seat's coins leave
  seatGap: 180, // each next seat launches this much later
  coinGap: 70, // coins from one seat follow each other
  coinsPerSeat: 3,
  flight: 600,
};
const landingAt = (seat) => POT_TIMING.firstLaunch + seat * POT_TIMING.seatGap + POT_TIMING.flight;
export const POT_FULL_AT = landingAt(3) + (POT_TIMING.coinsPerSeat - 1) * POT_TIMING.coinGap + 80;

// Centre of each seat card relative to the table box, measured from the lobby's seat buttons.
function useSeatPoints(boxRef) {
  const [points, setPoints] = useState(null);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const b = box.getBoundingClientRect();
    const centre = { x: b.width / 2, y: b.height / 2 };
    const seats = [0, 1, 2, 3].map((s) => {
      const el = box.querySelector(`[data-testid="lobby-seat-${s}"]`);
      if (!el) return centre;
      const r = el.getBoundingClientRect();
      // Aim at the avatar (upper part of the card), not the card's middle.
      return { x: r.left - b.left + r.width / 2, y: r.top - b.top + Math.min(r.height * 0.42, 52) };
    });
    setPoints({ centre, seats });
  }, [boxRef]);
  return points;
}

function Flight({ from, to, delay, index }) {
  const jitterX = ((index * 37) % 17) - 8;
  const jitterY = ((index * 53) % 11) - 5;
  const dx = to.x + jitterX - from.x;
  const dy = to.y + jitterY - from.y;
  // Arc: lift the midpoint away from the straight line toward the table's top.
  const lift = Math.min(70, Math.hypot(dx, dy) * 0.35);
  return (
    <motion.span className="absolute left-0 top-0 -ml-[11px] -mt-[11px]" aria-hidden="true" data-testid="pot-coin"
      initial={{ x: from.x, y: from.y, scale: 0.5, opacity: 0, rotate: 0 }}
      animate={{
        x: [from.x, from.x + dx * 0.5, from.x + dx],
        y: [from.y, from.y + dy * 0.5 - lift, from.y + dy],
        scale: [0.5, 1.25, 0.8],
        opacity: [0, 1, 1, 0],
        rotate: [0, 200, 360],
      }}
      transition={{ duration: POT_TIMING.flight / 1000, delay: delay / 1000, ease: [0.45, 0, 0.25, 1], times: [0, 0.5, 1], opacity: { times: [0, 0.12, 0.92, 1], duration: POT_TIMING.flight / 1000, delay: delay / 1000 } }}>
      <span className="block drop-shadow-[0_6px_8px_rgba(0,0,0,.6)]"><CoinIcon size={22} /></span>
    </motion.span>
  );
}

function SeatDebit({ at, entry, delay }) {
  return (
    <span className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: at.x, top: at.y }} aria-hidden="true">
      <motion.span className="block whitespace-nowrap rounded-full border border-rose-200/40 bg-rose-950/85 px-2 py-0.5 font-mono text-xs font-bold text-rose-200 shadow-[0_6px_14px_-4px_rgba(0,0,0,.9)]"
        data-testid="pot-debit" initial={{ opacity: 0, y: 0 }}
        animate={{ opacity: [0, 1, 1, 0], y: [0, -14, -24, -34] }}
        transition={{ duration: 1.3, delay: delay / 1000, times: [0, 0.15, 0.7, 1], ease: "easeOut" }}>
        −{formatCoins(entry)}
      </motion.span>
    </span>
  );
}

// Coins leave every seated player and land in a pot in the middle of the lobby table; the pot counts up
// to the full table pot, then shows what each winner takes.
export function PotCollect({ boxRef, seats, entry, payout }) {
  const points = useSeatPoints(boxRef);
  const reduced = prefersReducedMotion();
  const paying = seats.map((p, i) => (p ? i : null)).filter((i) => i !== null);
  const total = entry * paying.length;
  const [landed, setLanded] = useState(reduced ? paying.length : 0);

  useEffect(() => {
    if (reduced) return undefined;
    const timers = [];
    paying.forEach((seat, n) => {
      for (let c = 0; c < POT_TIMING.coinsPerSeat; c += 1) {
        const at = landingAt(n) + c * POT_TIMING.coinGap;
        sound.chime("coin_drop", { delay: at, gain: c === 0 ? 1 : 0.6 });
      }
      timers.push(setTimeout(() => setLanded((v) => Math.max(v, n + 1)), landingAt(n) + 20));
    });
    sound.chime("pot_full", { delay: POT_FULL_AT });
    return () => timers.forEach(clearTimeout);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const full = landed >= paying.length;
  return (
    <div className="pointer-events-none absolute inset-0 z-30" data-testid="pot-collect">
      {!reduced && points && paying.map((seat, n) => (
        <span key={seat}>
          <SeatDebit at={points.seats[seat]} entry={entry} delay={POT_TIMING.firstLaunch + n * POT_TIMING.seatGap} />
          {Array.from({ length: POT_TIMING.coinsPerSeat }, (_, c) => (
            <Flight key={c} index={seat * 3 + c} from={points.seats[seat]} to={points.centre}
              delay={POT_TIMING.firstLaunch + n * POT_TIMING.seatGap + c * POT_TIMING.coinGap} />
          ))}
        </span>
      ))}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <motion.div className="relative flex flex-col items-center rounded-3xl border border-amber-300/50 bg-gradient-to-b from-[#20160a]/95 to-[#0d0a05]/95 px-4 pb-2.5 pt-2 text-center shadow-[0_18px_40px_-14px_rgba(0,0,0,.95),inset_0_1px_0_rgba(255,255,255,.08)]"
          initial={reduced ? false : { scale: 0.6, opacity: 0 }} animate={{ scale: full ? [1, 1.08, 1] : 1, opacity: 1 }}
          transition={{ duration: full ? 0.45 : 0.3, ease: "easeOut" }}>
          {full && !reduced && (
            <motion.span className="absolute inset-0 rounded-3xl border-2 border-amber-200" aria-hidden="true"
              initial={{ opacity: 0.9, scale: 1 }} animate={{ opacity: 0, scale: 1.35 }} transition={{ duration: 0.8, ease: "easeOut" }} />
          )}
          <span className="relative flex h-9 items-end justify-center" aria-hidden="true">
            {Array.from({ length: Math.max(1, landed) }, (_, i) => (
              <motion.span key={i} className="-mx-1.5 block" style={{ marginBottom: (i % 2) * 5 }}
                initial={reduced ? false : { y: -10, opacity: 0 }} animate={{ y: 0, opacity: landed ? 1 : 0.25 }} transition={{ duration: 0.2 }}>
                <CoinIcon size={i % 2 ? 22 : 26} />
              </motion.span>
            ))}
          </span>
          <span className="mt-1 text-[9px] font-bold uppercase tracking-[0.22em] text-amber-100/60">Table pot</span>
          <motion.span key={landed} className="font-mono text-2xl font-black leading-none text-amber-300 drop-shadow-[0_2px_8px_rgba(251,191,36,.35)]"
            initial={reduced ? false : { scale: 1.3 }} animate={{ scale: 1 }} transition={{ duration: 0.25 }} data-testid="pot-amount">
            {formatCoins(entry * landed)}
          </motion.span>
          <span className={`mt-1 whitespace-nowrap text-[10px] font-semibold transition-opacity duration-300 ${full ? "text-emerald-300 opacity-100" : "opacity-0"}`} data-testid="pot-payout">
            Winners get {formatCoins(payout)} each
          </span>
        </motion.div>
      </div>
      <span className="sr-only" aria-live="polite">{full ? `${formatCoins(total)} coins in the pot. Winners get ${formatCoins(payout)} each.` : ""}</span>
    </div>
  );
}
