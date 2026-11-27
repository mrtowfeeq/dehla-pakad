import { Crown, Gem, Shield, Star } from "lucide-react";

// Display only: every player's league and level come from the server (backend/leagues.py).
export const LEAGUE_ORDER = ["bronze", "silver", "gold", "platinum", "diamond", "master", "legend"];
export const LEAGUE_NAME = { bronze: "Bronze", silver: "Silver", gold: "Gold", platinum: "Platinum", diamond: "Diamond", master: "Master", legend: "Legend" };

export const LEAGUE_THEME = {
  bronze: { face: "from-orange-200 via-amber-600 to-amber-900", ring: "ring-amber-700/60", text: "text-amber-300", glow: "rgba(217,119,6,.55)", Icon: Shield },
  silver: { face: "from-white via-slate-300 to-slate-500", ring: "ring-slate-300/60", text: "text-slate-200", glow: "rgba(203,213,225,.55)", Icon: Shield },
  gold: { face: "from-yellow-100 via-amber-300 to-amber-600", ring: "ring-amber-300/70", text: "text-amber-200", glow: "rgba(251,191,36,.6)", Icon: Star },
  platinum: { face: "from-cyan-50 via-teal-200 to-teal-500", ring: "ring-teal-200/60", text: "text-teal-200", glow: "rgba(94,234,212,.55)", Icon: Star },
  diamond: { face: "from-sky-100 via-sky-300 to-indigo-500", ring: "ring-sky-300/60", text: "text-sky-200", glow: "rgba(125,211,252,.6)", Icon: Gem },
  master: { face: "from-fuchsia-200 via-purple-400 to-purple-800", ring: "ring-purple-300/60", text: "text-purple-200", glow: "rgba(192,132,252,.6)", Icon: Crown },
  legend: { face: "from-rose-200 via-red-500 to-amber-500", ring: "ring-rose-300/70", text: "text-rose-200", glow: "rgba(251,113,133,.65)", Icon: Crown },
};

export const ROMAN = ["I", "II", "III", "IV", "V"];

/** "Gold III" from a server league object ({id|league, name|league_name, level, level_label}). */
export function leagueLabel(l) {
  if (!l) return "";
  const id = l.id || l.league;
  const name = l.name || l.league_name || LEAGUE_NAME[id] || "";
  const label = l.level_label || ROMAN[(l.level || 1) - 1] || "";
  return `${name} ${label}`.trim();
}

/** A league crest: a gradient shield with the league icon and the level numeral. */
export function LeagueBadge({ league, size = 40, showLevel = true, className = "", testId }) {
  const id = league?.id || league?.league || "bronze";
  const theme = LEAGUE_THEME[id] || LEAGUE_THEME.bronze;
  const level = league?.level_label || ROMAN[(league?.level || 1) - 1];
  const Icon = theme.Icon;
  return (
    <span className={`relative inline-flex shrink-0 items-center justify-center ${className}`} style={{ width: size, height: size }}
      role="img" aria-label={`${leagueLabel(league) || LEAGUE_NAME[id]} league`} data-testid={testId} data-league={id}>
      <span className={`absolute inset-0 bg-gradient-to-b ${theme.face} ring-2 ${theme.ring}`}
        style={{ clipPath: "polygon(50% 0, 100% 16%, 100% 62%, 50% 100%, 0 62%, 0 16%)", boxShadow: `0 0 ${size / 3}px ${theme.glow}` }} aria-hidden="true" />
      <span className="absolute inset-[14%] bg-black/25" style={{ clipPath: "polygon(50% 0, 100% 16%, 100% 62%, 50% 100%, 0 62%, 0 16%)" }} aria-hidden="true" />
      <span className="relative flex flex-col items-center leading-none text-white drop-shadow-[0_1px_2px_rgba(0,0,0,.8)]" aria-hidden="true">
        <Icon size={Math.max(10, size * 0.34)} strokeWidth={2.4} />
        {showLevel && level && <span className="mt-0.5 font-mono font-black" style={{ fontSize: Math.max(8, size * 0.22) }}>{level}</span>}
      </span>
    </span>
  );
}

/** A labelled progress bar (0-100). */
export function ProgressBar({ percent, label, detail, tone = "from-amber-300 to-orange-500", testId }) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  return (
    <div data-testid={testId}>
      <div className="mb-1 flex flex-wrap justify-between gap-x-3 text-[11px] text-white/60">
        <span>{label}</span>{detail && <span className="font-mono text-white/75">{detail}</span>}
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-black/40 shadow-[inset_0_1px_2px_rgba(0,0,0,.6)]" role="progressbar"
        aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
        <div className={`h-full rounded-full bg-gradient-to-r ${tone} transition-[width] duration-700`} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}
