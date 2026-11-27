import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { useApp } from "@/context/AppContext";
import { LeagueBadge, leagueLabel } from "@/components/leagues/League";

// Your league crest and lifetime medals for the header; links to the medal leaderboard. The league comes
// from the server (refreshed after every level or league change); the medal count updates live.
export function LeagueChip({ className = "" }) {
  const { me } = useApp();
  if (!me?.league) return null;
  const medals = Number(me.medals) || 0;
  return (
    <Link to="/leaderboard?board=medals" data-testid="league-chip" title={`${leagueLabel(me.league)} · ${medals.toLocaleString("en-IN")} medals`}
      className={`inline-flex items-center gap-1.5 rounded-full border border-orange-300/35 bg-gradient-to-r from-orange-300/15 to-transparent py-0.5 pl-0.5 pr-0.5 text-sm sm:pr-2.5 font-bold text-orange-100 transition-colors hover:border-orange-300/70 ${className}`}>
      <LeagueBadge league={me.league} size={26} />
      <motion.span key={medals} initial={{ scale: 1.25, opacity: 0.6 }} animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 380, damping: 18 }} className="hidden font-mono tabular-nums sm:inline" data-testid="league-chip-medals">
        {medals.toLocaleString("en-IN")}
      </motion.span>
    </Link>
  );
}
