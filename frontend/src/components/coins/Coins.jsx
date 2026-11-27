// Coins are game coins only: earned in play, never bought or cashed out. Indian digit grouping (1,00,000).
// Pure helpers (no app context) so any component, including the game table, can use them.
export const formatCoins = (n) => (Number.isFinite(n) ? Math.max(0, Math.round(n)).toLocaleString("en-IN") : "—");

export const COIN_REASON_LABEL = {
  starting_coins: "Welcome coins",
  daily: "Daily reward",
  topup: "Free coins",
  stake_entry: "Table entry",
  stake_win: "Table win",
  stake_refund: "Entry refunded",
};

// A small gold coin (no currency symbol: these are game coins, not money).
export function CoinIcon({ size = 16, className = "" }) {
  return (
    <span aria-hidden="true" className={`relative inline-flex shrink-0 items-center justify-center rounded-full border border-amber-100/70 bg-gradient-to-br from-amber-100 via-amber-300 to-amber-600 shadow-[inset_0_1px_0_rgba(255,255,255,.6),0_1px_3px_rgba(0,0,0,.5)] ${className}`}
      style={{ width: size, height: size }}>
      <span className="absolute inset-[18%] rounded-full border border-amber-700/40" />
    </span>
  );
}
