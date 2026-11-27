// Wording for server-computed medal changes (see backend/medals.py). Nothing here calculates medals:
// it only labels the numbers the server stored for a round.

export const VICTORY_MEDALS = { normal: 1, koth: 4, grand_slam: 13 };
const VICTORY_NAME = { normal: "Normal", koth: "Koth", grand_slam: "Grand Slam" };

export const victoryName = (type) => VICTORY_NAME[type] || "Victory";

export const signed = (n) => {
  const v = Number(n) || 0;
  if (v > 0) return `+${v.toLocaleString("en-IN")}`;
  if (v < 0) return `−${Math.abs(v).toLocaleString("en-IN")}`;
  return "0";
};

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The actual change applied to the player's lifetime medals (older records: the requested one). */
export function netChange(p) {
  if (!p) return 0;
  if (p.change !== null && p.change !== undefined) return Number(p.change) || 0;
  if (p.requested !== null && p.requested !== undefined) return Number(p.requested) || 0;
  return Number(p.medals) || 0;
}

/** Whether a losing player's penalty was only partly taken because their balance reached zero. */
export function floored(p) {
  return !!p && p.won === false && p.change !== null && p.change !== undefined && Math.abs(p.change) < (p.penalty || 0);
}

/**
 * The parts of a player's round change, for display: [{ key, label, value }].
 * Winners: trick medals, ten bonus, victory bonus. Losers: the victory penalty only.
 * Older records without the split show a single line.
 */
export function medalParts(p, type) {
  if (!p) return [];
  const name = victoryName(type);
  if (p.won === false) {
    return [{ key: "penalty", label: `${name} loss penalty`, value: -(p.penalty || 0) }];
  }
  if (p.trick_medals === undefined) {
    return [{ key: "total", label: `${plural(p.tricks || 0, "trick")} · ${plural(p.tens || 0, "ten")}`, value: netChange(p) }];
  }
  // Trick and ten parts only when there is something to show; the victory bonus always.
  return [
    p.tricks ? { key: "tricks", label: plural(p.tricks, "trick"), value: p.trick_medals || 0 } : null,
    p.tens ? { key: "tens", label: `${plural(p.tens, "ten")} bonus`, value: p.ten_medals || 0 } : null,
    { key: "bonus", label: `${name} win bonus`, value: p.bonus || 0 },
  ].filter(Boolean);
}

/** One-line description: "2 tricks +2 · 3 tens bonus +9 · Koth win bonus +4". */
export function medalSummary(p, type) {
  const parts = medalParts(p, type).map((x) => `${x.label} ${signed(x.value)}`).join(" · ");
  if (floored(p)) return `${parts} · only ${Math.abs(p.change)} taken (medals never go below 0)`;
  return parts;
}

/** Compact winner line for tight spaces: "+5 tricks · +9 tens · +4 Koth" (full wording in medalSummary). */
export function medalShort(p, type) {
  if (!p) return "";
  if (p.won === false || p.trick_medals === undefined) return medalSummary(p, type);
  return [
    p.trick_medals ? `${signed(p.trick_medals)} trick${p.tricks === 1 ? "" : "s"}` : null,
    p.ten_medals ? `${signed(p.ten_medals)} ten${p.tens === 1 ? "" : "s"}` : null,
    `${signed(p.bonus || 0)} ${victoryName(type)}`,
  ].filter(Boolean).join(" · ");
}