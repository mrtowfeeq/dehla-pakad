import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { useApp } from "@/context/AppContext";
import { CoinIcon, formatCoins } from "@/components/coins/Coins";

// Coin balance for the header; the number pops when it changes. Links to the wallet.
export function CoinBadge({ className = "" }) {
  const { me } = useApp();
  if (!Number.isFinite(me?.coins)) return null;
  return (
    <Link to="/wallet" data-testid="coin-badge" title="Your coins"
      className={`inline-flex items-center gap-1.5 rounded-full border border-amber-300/40 bg-gradient-to-r from-amber-300/15 to-transparent py-1 pl-1 pr-2.5 text-sm font-bold text-amber-200 transition-colors hover:border-amber-300/80 ${className}`}>
      <CoinIcon size={20} />
      <motion.span key={me.coins} initial={{ scale: 1.25, opacity: 0.6 }} animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 380, damping: 18 }} className="font-mono tabular-nums" data-testid="coin-balance">
        {formatCoins(me.coins)}
      </motion.span>
    </Link>
  );
}
