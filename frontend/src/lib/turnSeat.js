const TIMED_PHASES = ["playing", "trump_select", "koth_decision", "gs_decision"];

// The server names the seat that owns the shared turn timer (for a team decision it skips a bot whose
// partner is human). Older snapshots without turn_seat fall back to the acting seat.
export function timerSeatFor(st, turnSeat) {
  if (!st || !TIMED_PHASES.includes(st.phase)) return null;
  if (Number.isInteger(turnSeat)) return turnSeat;
  return st.phase === "trump_select" ? st.trump_selector : st.turn;
}
