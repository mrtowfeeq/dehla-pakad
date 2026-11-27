import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { CoinIcon, formatCoins } from "@/components/coins/Coins";
import { sound } from "@/lib/sound";
import { prefersReducedMotion } from "@/hooks/useTableEffects";

// Timeline (ms) of the match-end payout. It starts after the result screen has settled in.
export const PAYOUT_TIMING = { start: 650, coins: 12, gap: 85, fall: 620 };
const landAt = (i) => PAYOUT_TIMING.start + i * PAYOUT_TIMING.gap + PAYOUT_TIMING.fall;
export const PAYOUT_DONE_AT = landAt(PAYOUT_TIMING.coins - 1) + 60;

// One coin of the winnings: pops up out of the table pot above, tumbles and drops into the chip's coin.
function FallingCoin({ index }) {
  // Spread the coins in a fan above the chip, alternating sides, a little random-looking but stable.
  const side = index % 2 ? 1 : -1;
  const fromX = side * (24 + ((index * 29) % 90));
  const fromY = -70 - ((index * 17) % 40);
  const delay = (PAYOUT_TIMING.start + index * PAYOUT_TIMING.gap) / 1000;
  return (
    <motion.span className="absolute left-[9px] top-1/2 -ml-[10px] -mt-[10px]" aria-hidden="true" data-testid="payout-coin"
      initial={{ x: 0, y: 8, opacity: 0, scale: 0.4 }}
      animate={{ x: [0, fromX, 0], y: [8, fromY, 0], opacity: [0, 1, 1, 0], scale: [0.4, 1.15, 0.75], rotate: [0, side * 220, side * 400] }}
      transition={{ duration: PAYOUT_TIMING.fall / 1000, delay, times: [0, 0.45, 1], ease: [0.3, 0, 0.35, 1],
        opacity: { duration: PAYOUT_TIMING.fall / 1000, delay, times: [0, 0.1, 0.9, 1] } }}>
      <span className="block drop-shadow-[0_6px_8px_rgba(0,0,0,.6)]"><CoinIcon size={20} /></span>
    </motion.span>
  );
}

// The coin line on the match result: winners watch their share of the pot pour in and count up;
// the losing side sees its entry coin slip away.
export function CoinPayout({ won, stake }) {
  const reduced = prefersReducedMotion();
  const { coins, start } = PAYOUT_TIMING;
  const [landed, setLanded] = useState(!won || reduced ? coins : 0);

  useEffect(() => {
    if (!won || reduced) return undefined;
    const timers = Array.from({ length: coins }, (_, i) => setTimeout(() => setLanded(i + 1), landAt(i)));
    for (let i = 0; i < coins; i += 1) sound.chime?.("coin_drop", { delay: landAt(i), gain: 0.55 });
    sound.chime?.("pot_full", { delay: PAYOUT_DONE_AT, gain: 0.8 });
    return () => timers.forEach(clearTimeout);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const done = landed >= coins;
  const final = won ? `+${formatCoins(stake.payout)}` : `−${formatCoins(stake.entry)}`;
  const shown = won ? `+${formatCoins(Math.round((stake.payout * landed) / coins))}` : final;
  return (
    <div className={`relative mt-3 inline-flex items-center gap-2 rounded-2xl border px-3 py-2 text-sm font-bold ${won ? "border-emerald-300/40 bg-emerald-400/10 text-emerald-200" : "border-rose-300/30 bg-rose-400/10 text-rose-200"}`}
      data-testid="match-coin-result" data-won={won ? "true" : "false"} aria-label={`${final} coins, ${stake.name}`}>
      {won && !reduced && Array.from({ length: coins }, (_, i) => <FallingCoin key={i} index={i} />)}
      {won && done && !reduced && (
        <motion.span className="pointer-events-none absolute inset-0 rounded-2xl border-2 border-emerald-200" aria-hidden="true"
          initial={{ opacity: 0.9, scale: 1 }} animate={{ opacity: 0, scale: 1.25 }} transition={{ duration: 0.7, ease: "easeOut" }} />
      )}
      <motion.span key={landed} className="relative block" aria-hidden="true"
        initial={won && !reduced && landed ? { scale: 1.35 } : false} animate={{ scale: 1 }} transition={{ duration: 0.18 }}>
        <CoinIcon size={18} />
        {!won && !reduced && (
          // The entry coin slips out of the chip and fades away.
          <motion.span className="absolute inset-0" initial={{ y: 0, opacity: 0.95 }} animate={{ y: 26, opacity: 0, rotate: 70 }}
            transition={{ duration: 0.9, delay: 0.7, ease: [0.5, 0, 0.75, 0] }} data-testid="payout-lost-coin">
            <CoinIcon size={18} />
          </motion.span>
        )}
      </motion.span>
      <span className="font-mono tabular-nums" data-testid="match-coin-amount">{shown} coins</span>
      <span className="font-normal text-white/60">· {stake.name}</span>
      {won && (
        <span className={`hidden text-[10px] font-semibold uppercase tracking-wider text-emerald-200/70 transition-opacity duration-300 sm:inline ${done ? "opacity-100" : "opacity-0"}`}>
          Added to your wallet
        </span>
      )}
    </div>
  );
}
