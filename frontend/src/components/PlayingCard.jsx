import { SUIT_SYMBOL, isRed, cardRank, cardSuit } from "@/lib/api";

const SIZES = {
  xs: "w-8 h-11 text-[10px] rounded-md p-0.5",
  sm: "w-11 h-16 text-xs rounded-md p-1",
  md: "w-14 h-20 sm:w-16 sm:h-24 text-sm sm:text-base rounded-lg p-1.5",
  hand: "w-12 h-[72px] text-xs rounded-lg p-1 sm:w-20 sm:h-28 sm:text-lg sm:p-2 md:w-[88px] md:h-[124px]",
  lg: "w-16 h-24 sm:w-20 sm:h-28 md:w-[88px] md:h-[124px] text-base sm:text-lg rounded-xl p-1.5 sm:p-2",
};

export function PlayingCard({ card, size = "md", className = "", testId, ...rest }) {
  const s = cardSuit(card), r = cardRank(card);
  const color = isRed(s) ? "text-rose-600" : "text-slate-900";
  return (
    <div
      data-testid={testId || `card-item-${s}-${r}`}
      className={`relative bg-white border border-slate-200 shadow-[0_6px_16px_-6px_rgba(0,0,0,.55)] flex flex-col justify-between select-none ${SIZES[size]} ${color} ${className}`}
      {...rest}
    >
      <div className="leading-none font-bold">
        <div>{r}</div>
        <div className="-mt-0.5">{SUIT_SYMBOL[s]}</div>
      </div>
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <span className={size === "xs" ? "text-base" : size === "sm" ? "text-xl" : size === "hand" ? "text-2xl sm:text-4xl" : "text-3xl sm:text-4xl"}>{SUIT_SYMBOL[s]}</span>
      </div>
      <div className="leading-none font-bold self-end rotate-180">
        <div>{r}</div>
      </div>
      {r === "10" && size !== "xs" && <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-amber-400" />}
    </div>
  );
}

export function CardBack({ size = "sm", className = "" }) {
  return (
    <div className={`${SIZES[size]} ${className} bg-gradient-to-br from-indigo-900 via-blue-950 to-slate-950 border border-amber-400/40 shadow-md flex items-center justify-center`}>
      <div className="w-full h-full rounded-[inherit] border border-amber-300/25 bg-[repeating-linear-gradient(45deg,rgba(245,184,51,.08)_0_4px,transparent_4px_8px)]" />
    </div>
  );
}
