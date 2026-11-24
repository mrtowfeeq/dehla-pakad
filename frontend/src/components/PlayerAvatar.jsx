import { Crown, Star, Flame, Gem } from "lucide-react";

const GLYPH = { spade: "♠", heart: "♥", diamond: "♦", club: "♣" };
const ICON = { crown: Crown, star: Star, flame: Flame, gem: Gem };

export function PlayerAvatar({ user, size = 40, online, ring = "", className = "" }) {
  const color = user?.avatar_color || "#64748b";
  const Icon = ICON[user?.avatar_icon];
  const glyph = GLYPH[user?.avatar_icon];
  return (
    <div className={`relative shrink-0 ${className}`} style={{ width: size, height: size }}>
      <div
        className={`w-full h-full rounded-full flex items-center justify-center font-bold text-slate-950 ${ring}`}
        style={{ background: `radial-gradient(circle at 30% 25%, #fff8, transparent 55%), ${color}` }}
      >
        {Icon ? <Icon size={size * 0.48} strokeWidth={2.4} /> : glyph ? <span style={{ fontSize: size * 0.5 }}>{glyph}</span> : (user?.username || "?")[0]?.toUpperCase()}
      </div>
      {online !== undefined && (
        <span
          data-testid={`presence-dot-${user?.username || "player"}`}
          className={`absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-background ${online ? "bg-emerald-400" : "bg-slate-500"}`}
          style={{ width: Math.max(10, size * 0.28), height: Math.max(10, size * 0.28) }}
        />
      )}
    </div>
  );
}
