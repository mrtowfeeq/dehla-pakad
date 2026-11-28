import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { WifiOff, Bot } from "lucide-react";
import { Link } from "react-router-dom";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { PlayingCard } from "@/components/PlayingCard";
import { TurnTimer } from "@/components/game/TurnTimer";
import { SUIT_SYMBOL, SUIT_NAME, TEAM_NAME, isRed, cardSuit } from "@/lib/api";
import { sound } from "@/lib/sound";
import { timerSeatFor } from "@/lib/turnSeat";
import { cardPose, computeHandLayout, computeTwoRowHandLayout, rowOf, usesTwoRows } from "@/lib/handLayout";

export const relOf = (seat, mySeat) => (seat - mySeat + 4) % 4;
const tl = (t) => (t === 0 ? "a" : "b");

function TenChip({ card }) {
  const s = cardSuit(card);
  return (
    <span data-testid={`captured-ten-${card}`} className={`inline-flex flex-col items-center justify-center w-4 h-[22px] sm:w-5 sm:h-7 rounded-[4px] bg-white shadow-md leading-none font-bold text-[7px] sm:text-[9px] ${isRed(s) ? "text-rose-600" : "text-slate-900"}`}>
      10<span className="text-[9px] sm:text-[11px]">{SUIT_SYMBOL[s]}</span>
    </span>
  );
}

export function TeamTrickCounter({ team, value, short = false, bare = false }) {
  const teamKey = tl(team);
  return (
    <div
      className={`inline-flex items-center rounded-lg border py-1 ${bare ? "gap-0 px-1.5" : "gap-2 px-2"} ${team === 0 ? "border-sky-300/30 bg-sky-300/10" : "border-amber-300/30 bg-amber-300/10"}`}
      data-testid={`team-trick-counter-${teamKey}`}
      aria-label={`${TEAM_NAME[team]} won ${value} tricks this round`}
      title={`${TEAM_NAME[team]} tricks this round`}
    >
      <span className={`${bare ? "sr-only" : ""} text-[8px] sm:text-[9px] font-bold uppercase tracking-[0.12em] ${team === 0 ? "text-sky-200" : "text-amber-200"}`}>
        {short ? "Tricks" : <><span className="sm:hidden">Tricks</span><span className="hidden sm:inline">Round tricks</span></>}
      </span>
      <motion.span
        key={`${teamKey}-${value}`}
        initial={{ opacity: 0.55, y: 3, scale: 0.85 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 360, damping: 22 }}
        className={`font-mono text-base sm:text-lg font-bold leading-none tabular-nums ${team === 0 ? "text-sky-100" : "text-amber-100"}`}
        data-testid={`tricks-team-${teamKey}`}
        aria-live="polite"
        aria-atomic="true"
      >
        {value}
      </motion.span>
    </div>
  );
}

// A team's own tens: "2 tens" plus the captured ten cards. The total out of four sits in the middle of the
// header (TensTotal). terse (narrow landscape): the captured cards carry the count; the words stay in the
// tooltip and accessible text.
function TensCounter({ st, team, terse = false }) {
  const n = st.tens[team].length;
  const words = `${n} ${n === 1 ? "ten" : "tens"}`;
  return (
    <div className="flex min-h-6 items-center gap-1" data-testid={`tens-counter-team-${tl(team)}`} title={`${TEAM_NAME[team]}: ${words} captured this round`}>
      <span className={`whitespace-nowrap font-mono text-[9px] text-white/60 ${terse ? "sr-only" : ""}`} data-testid={`tens-count-team-${tl(team)}`}>{words}</span>
      <div className={`flex ${terse ? "-space-x-1.5" : "gap-0.5"}`}>
        {st.tens[team].map((c) => <TenChip key={c} card={c} />)}
      </div>
    </div>
  );
}

function ScoreValue({ st, team, className = "text-lg sm:text-2xl" }) {
  return (
    <span className={`shrink-0 font-mono font-bold leading-none tabular-nums ${className}`} data-testid={`score-team-${tl(team)}`}>
      {st.scores[team]}<span className="text-[10px] text-white/45">/{st.target}</span>
    </span>
  );
}

// compact: short screens drop the progress bar (the score is shown as "4/5") and put the trick counter
// and the tens on one line instead of two.
function TeamScore({ st, team, mine, align, compact = false }) {
  return (
    <div className={`flex min-w-0 flex-col ${align === "right" ? "items-end" : "items-start"}`}>
      <div className={`flex w-full min-w-0 items-baseline justify-between gap-1 ${align === "right" ? "flex-row-reverse" : ""}`}>
        <span className={`truncate text-[9px] sm:text-[10px] font-bold uppercase tracking-[0.15em] text-team-${tl(team)}`}>{TEAM_NAME[team]}{mine ? " · YOU" : ""}</span>
        <ScoreValue st={st} team={team} />
      </div>
      {!compact && (
        <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white/10" aria-hidden="true">
          <span
            className={`block h-full rounded-full transition-[width] duration-500 ${team === 0 ? "bg-sky-300" : "bg-amber-300"}`}
            style={{ width: `${Math.min(100, Math.max(0, (st.scores[team] / Math.max(st.target, 1)) * 100))}%` }}
          />
        </div>
      )}
      <div className={`mt-1 flex w-full gap-1 ${compact ? `flex-wrap items-center ${align === "right" ? "flex-row-reverse" : ""}` : `flex-col ${align === "right" ? "items-end" : "items-start"}`}`}>
        <TeamTrickCounter team={team} value={st.tricks_won[team]} />
        <TensCounter st={st} team={team} />
      </div>
    </div>
  );
}

// One-line team summary for landscape phones: name, score, tricks and captured tens. narrow: the team is
// shown by its letter (full name in the tooltip) and the tens as "n/4" next to the captured ten cards.
function TeamScoreInline({ st, team, mine, align, narrow = false }) {
  const label = `${TEAM_NAME[team]}${mine ? " · YOU" : ""}`;
  return (
    <div className={`flex min-w-0 items-center ${narrow ? "gap-1" : "gap-2"} ${align === "right" ? "flex-row-reverse" : ""}`} data-testid={`team-inline-${tl(team)}`} title={label}>
      <span className={`shrink-0 whitespace-nowrap text-[9px] font-bold uppercase tracking-[0.12em] text-team-${tl(team)}`}>{narrow ? `${tl(team).toUpperCase()}${mine ? "·YOU" : ""}` : label}</span>
      <ScoreValue st={st} team={team} className="text-base" />
      <TeamTrickCounter team={team} value={st.tricks_won[team]} short bare={narrow} />
      <TensCounter st={st} team={team} terse={narrow} />
    </div>
  );
}

// Tens captured by both teams so far, out of four: Team A's fill from the left (blue), Team B's from the
// right (amber), uncaptured ones stay empty. inline: one line beside the trump badge (landscape header).
function TensTotal({ st, inline = false }) {
  const a = st.tens[0].length;
  const b = st.tens[1].length;
  const total = a + b;
  return (
    <div className={`flex items-center ${inline ? "gap-1" : "mt-1 flex-col gap-0.5"}`} data-testid="tens-total"
      title={`${total} of 4 tens captured · ${TEAM_NAME[0]} ${a}, ${TEAM_NAME[1]} ${b}`}>
      <div className="flex gap-[3px]" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={`h-1.5 w-2.5 rounded-full ${i < a ? "bg-sky-300" : i >= 4 - b ? "bg-amber-300" : "bg-white/15"}`} />
        ))}
      </div>
      <span className="whitespace-nowrap font-mono text-[9px] font-bold leading-none text-white/85">
        <span data-testid="tens-total-count">{total}/4</span>{!inline && <span className="font-normal text-white/50"> tens</span>}
      </span>
    </div>
  );
}

function TrumpBadge({ st, small = false }) {
  return (
    <div className="flex flex-col items-center" data-testid="trump-indicator-badge" title={st.trump ? SUIT_NAME[st.trump] : "Trump not chosen"}>
      {/* Gold coin once trump is chosen; a dark coin with "?" before. */}
      <div className={`flex items-center justify-center rounded-full border-2 ${st.trump
        ? `border-amber-100/80 bg-gradient-to-br from-amber-50 via-amber-200 to-amber-500 shadow-[inset_0_2px_0_rgba(255,255,255,.6),0_0_22px_rgba(251,191,36,.35)] ${isRed(st.trump) ? "text-rose-700" : "text-slate-950"}`
        : "border-amber-300/40 bg-gradient-to-br from-[#1b2a4a] to-[#0a1120] text-amber-200/70 shadow-[0_0_16px_rgba(245,190,75,.1)]"} ${small ? "h-8 w-8 text-lg" : "h-9 w-9 text-xl sm:h-11 sm:w-11 sm:text-2xl"}`}>
        {st.trump ? SUIT_SYMBOL[st.trump] : "?"}
      </div>
      {!small && <span className="mt-0.5 text-[8px] font-bold uppercase tracking-[0.16em] text-amber-200/80 sm:text-[9px]">{st.trump ? SUIT_NAME[st.trump] : "Trump"}</span>}
    </div>
  );
}

// iconOnly (narrow landscape): a green dot or the wifi-off icon; the words stay as accessible text/tooltip.
function ConnectionStatus({ connected, iconOnly = false, quiet = false }) {
  const label = connected ? "Live" : "Reconnecting";
  // quiet: inside the status bar a healthy connection is just a green dot (the header already says the
  // game is live); losing the connection still shows the full "Reconnecting" warning.
  if (quiet && connected) {
    return (
      <span data-testid="connection-status" title="Connected" className="inline-flex items-center">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,.8)]" aria-hidden="true" />
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  return (
    <span data-testid="connection-status" title={label} className={`inline-flex items-center gap-1 rounded-full py-1 ${iconOnly ? "px-1.5" : "px-2"} ${connected ? "bg-emerald-300/10 text-emerald-200" : "bg-amber-300/10 text-amber-200"}`}>
      {connected ? <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> : <WifiOff size={10} />}
      <span className={iconOnly ? "sr-only" : ""}>{label}</span>
    </span>
  );
}

function BonusBadges({ st }) {
  return (
    <>
      {st.koth !== null && <span className="rounded-full bg-amber-300/10 px-2 py-1 font-bold text-amber-200" data-testid="koth-active-badge">KOTH · {TEAM_NAME[st.koth]}</span>}
      {st.gs_declared !== null && <span className="rounded-full bg-rose-300/10 px-2 py-1 font-bold text-rose-200" data-testid="grand-slam-active-badge">GRAND SLAM · {TEAM_NAME[st.gs_declared]}</span>}
    </>
  );
}

export function CurrentSuitIndicator({ trick = [] }) {
  const firstCard = Array.isArray(trick?.[0]) && typeof trick[0][1] === "string" ? trick[0][1] : null;
  const suit = firstCard ? cardSuit(firstCard) : null;
  if (!SUIT_SYMBOL[suit]) return null;

  return (
    <div className="trick-center-cell col-start-2 row-start-2 flex items-center justify-center pointer-events-none" data-testid="current-suit-indicator">
      <span className={`trick-center-symbol font-display text-3xl leading-none sm:text-4xl lg:text-5xl ${isRed(suit) ? "text-rose-300" : "text-amber-100"}`} data-testid="current-suit-symbol" role="img" aria-label={`Current suit ${SUIT_SYMBOL[suit]}`}>
        {SUIT_SYMBOL[suit]}
      </span>
    </div>
  );
}

// Phone-width labels for the header's phase segment (the full name shows from the sm breakpoint up).
const PHASE_SHORT = { trump_select: "Trump", koth_decision: "Koth", gs_decision: "13 Mann", round_over: "Round end", match_over: "Match end" };

// density: "regular" (desktop, tablets, tall phones), "short" (phones up to 700px high) or "tiny"
// (landscape phones up to 500px high). Dealer, "to act" and phase chips are left out of the denser
// headers because the table already shows them: the dealer's "D" badge, the active seat's glow and the
// turn pill, and the phase prompts and banners.
export function Hud({ st, left, right, connected, roomCode, gameStatus, players = [], density = "regular", narrow = false }) {
  const myTeam = st.my_seat % 2;
  const currentTrick = Math.min(st.tricks_played + (st.trick.length ? 1 : 0), 13);
  const dealer = players.find((player) => player.seat === st.dealer);
  const actorSeat = st.phase === "trump_select" ? st.trump_selector : st.turn;
  const actor = players.find((player) => player.seat === actorSeat);
  const decisionTeam = st.phase === "koth_decision" ? st.koth_decision
    : st.phase === "gs_decision" ? st.gs_eligible : null;
  const phaseName = {
    trump_select: "Trump selection",
    playing: "Playing",
    koth_decision: "Koth decision",
    gs_decision: "Grand Slam decision",
    round_over: "Round complete",
    match_over: "Match complete",
  }[st.phase] || st.phase;
  const turnName = decisionTeam !== null && decisionTeam !== undefined
    ? `${TEAM_NAME[decisionTeam]} deciding`
    : actor ? (actor.seat === st.my_seat ? "Your turn" : actor.username) : "—";
  if (density === "tiny") {
    return (
      <header className="relative z-20 shrink-0 px-2 pt-[max(4px,env(safe-area-inset-top))]" data-testid="match-scoreboard" data-density="tiny">
        <div className="mx-auto flex max-w-6xl items-center gap-2 rounded-2xl border border-amber-300/25 bg-gradient-to-b from-[#0e241a]/95 to-[#050d09]/95 px-2 py-1 text-white shadow-[inset_0_1px_0_rgba(251,191,36,.18),0_14px_40px_-18px_rgba(0,0,0,.9)]">
          {left}
          <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
            <TeamScoreInline st={st} team={0} mine={myTeam === 0} narrow={narrow} />
            <div className="flex items-center gap-1.5"><TrumpBadge st={st} small /><TensTotal st={st} inline /></div>
            <TeamScoreInline st={st} team={1} mine={myTeam === 1} align="right" narrow={narrow} />
          </div>
          <div className="flex shrink-0 items-center gap-1 text-[9px] font-medium text-white/65" data-testid="round-info">
            <span className="rounded-full bg-white/5 px-2 py-1" title={`Room ${roomCode || "—"} · round ${st.round_no}, trick ${currentTrick} of 13`}>
              <b className="text-white/90">R</b>{st.round_no} · <b className="text-white/90">T</b>{currentTrick}/13
            </span>
            <ConnectionStatus connected={connected} iconOnly={narrow} />
            <BonusBadges st={st} />
          </div>
          {right}
        </div>
      </header>
    );
  }
  const short = density === "short";
  return (
    <header className={`relative z-20 shrink-0 px-2 sm:px-5 ${short ? "pt-[max(4px,env(safe-area-inset-top))]" : "pt-[max(8px,env(safe-area-inset-top))] sm:pt-4"}`} data-testid="match-scoreboard" data-density={density}>
      <div className="mx-auto max-w-6xl rounded-2xl border border-amber-300/25 bg-gradient-to-b from-[#0e241a]/95 to-[#050d09]/95 px-2 py-2 text-white shadow-[inset_0_1px_0_rgba(251,191,36,.18),0_14px_40px_-18px_rgba(0,0,0,.9)] sm:px-4 sm:py-3">
        <div className="flex min-w-0 items-center justify-between gap-2">
          {left}
          <div className="flex min-w-0 flex-1 items-center justify-center gap-2 sm:gap-3">
            <span className="hidden font-display text-[11px] tracking-[0.22em] text-amber-300 md:inline">DEHLA PAKAD</span>
            <span className="max-w-[112px] truncate rounded-full border border-white/10 bg-white/5 px-2 py-1 font-mono text-[9px] text-white/75 sm:max-w-none sm:text-[10px]" data-testid="room-id">
              ROOM {roomCode || "—"}
            </span>
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-emerald-300/20 bg-emerald-300/10 px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-emerald-200" data-testid="game-status">
              <span className={`h-1.5 w-1.5 rounded-full ${gameStatus === "active" ? "bg-emerald-300" : "bg-amber-300"}`} />
              {gameStatus === "active" ? "Live" : gameStatus || "Game"}
            </span>
          </div>
          {right}
        </div>

        <div className={`grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 rounded-xl border border-white/10 bg-[linear-gradient(90deg,rgba(56,189,248,.08),rgba(0,0,0,.25)_35%,rgba(0,0,0,.25)_65%,rgba(245,158,11,.08))] px-2 sm:gap-4 sm:px-4 ${short ? "mt-1.5 py-1.5" : "mt-2 py-2 sm:mt-3"}`}>
          <TeamScore st={st} team={0} mine={myTeam === 0} compact={short} />
          <div className="flex flex-col items-center"><TrumpBadge st={st} /><TensTotal st={st} /></div>
          <TeamScore st={st} team={1} mine={myTeam === 1} align="right" compact={short} />
        </div>

        {/* One segmented status bar. The last segment says whose turn it is during play and otherwise names the
            phase (trump choice, Koth / Grand Slam decision, round or match end). A healthy connection is a dot
            inside the bar; "Reconnecting" sits beside the bar so it never squeezes the names. */}
        <div className={`flex flex-wrap items-center justify-center gap-1.5 ${short ? "mt-1.5" : "mt-2"}`} data-testid="round-info">
          <div className="flex min-w-0 max-w-full items-stretch divide-x divide-white/10 overflow-hidden rounded-full border border-white/10 bg-black/30 text-[9px] font-medium text-white/60 shadow-[inset_0_1px_0_rgba(255,255,255,.04)] sm:text-[10px]">
            <span className="flex shrink-0 items-center gap-1 px-2.5 py-1"><span className="uppercase tracking-wider text-white/45">Round</span><b className="font-mono text-amber-100">{st.round_no}</b></span>
            <span className="flex shrink-0 items-center gap-1.5 px-2.5 py-1">
              <span className="uppercase tracking-wider text-white/45">Trick</span><b className="font-mono text-amber-100">{currentTrick}/13</b>
              <span className="hidden items-center gap-[2px] sm:flex" aria-hidden="true">
                {Array.from({ length: 13 }, (_, i) => <span key={i} className={`h-1.5 w-[3px] rounded-full ${i < st.tricks_played ? "bg-amber-300/80" : i === st.tricks_played && st.trick.length ? "bg-amber-200" : "bg-white/15"}`} />)}
              </span>
            </span>
            {!short && (
              <span className="flex min-w-0 items-center gap-1 px-2.5 py-1" title={`Dealer: ${dealer?.username || `Seat ${(st.dealer ?? 0) + 1}`}`}>
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-amber-200 to-amber-500 text-[8px] font-black text-slate-950" aria-hidden="true">D</span>
                <span className="sr-only">Dealer</span>
                <b className="min-w-[40px] max-w-[72px] truncate text-white/85 sm:max-w-[120px]">{dealer?.username || `Seat ${(st.dealer ?? 0) + 1}`}</b>
              </span>
            )}
            {!short && (st.phase === "playing" ? (
              <span className="flex min-w-0 items-center gap-1 px-2.5 py-1">
                <span className="uppercase tracking-wider text-white/45">Turn</span>
                <b className={`min-w-[48px] max-w-[96px] truncate sm:max-w-[140px] ${turnName === "Your turn" ? "text-amber-300" : "text-white/85"}`}>{turnName}</b>
              </span>
            ) : (
              <span className="flex min-w-0 items-center gap-1 px-2.5 py-1" title={`${phaseName}${decisionTeam !== null && decisionTeam !== undefined ? ` · ${TEAM_NAME[decisionTeam]}` : actor ? ` · ${actor.seat === st.my_seat ? "You" : actor.username}` : ""}`}>
                <span className="sr-only">Phase</span>
                <b className="min-w-0 truncate text-amber-200">
                  <span className="hidden sm:inline">{phaseName}</span>
                  <span className="sm:hidden">{PHASE_SHORT[st.phase] || phaseName}</span>
                </b>
                {decisionTeam !== null && decisionTeam !== undefined
                  ? <span className="shrink-0 text-white/60">· {TEAM_NAME[decisionTeam]}</span>
                  : st.phase === "trump_select" && actor ? <span className="min-w-0 truncate text-white/60">· {actor.seat === st.my_seat ? "You" : actor.username}</span> : null}
              </span>
            ))}
            {connected && <span className="flex shrink-0 items-center px-2 py-1"><ConnectionStatus connected quiet /></span>}
          </div>
          {!connected && <ConnectionStatus connected={false} />}
          <BonusBadges st={st} />
        </div>
      </div>
    </header>
  );
}

// compact: a slimmer horizontal panel for short screens (same information, ~44px tall instead of ~105px).
// mini: narrow landscape phones show only the avatar (with dealer/online badges) and the card count; the
// name and team stay in the panel's accessible label and tooltip.
export function SeatPanel({ player, st, mySeat, reaction, pending = 0, highlight, dealing, horizontal: horizontalProp, compact: compactProp = false, mini = false, turnDeadline, turnPhase, turnGraceDeadline, turnDuration, serverOffsetMs, turnSeat }) {
  const compact = compactProp || mini;
  const horizontal = horizontalProp || compact;
  const avatarSize = compact ? 28 : horizontal ? 34 : 38;
  const rel = relOf(player.seat, mySeat);
  const team = player.team;
  const isTurn = st.turn === player.seat || (st.phase === "trump_select" && st.trump_selector === player.seat && !dealing);
  const hasTurnTimer = timerSeatFor(st, turnSeat) === player.seat;
  const count = Math.max(0, st.hand_counts[player.seat] - pending);
  const deciding = (st.phase === "koth_decision" && st.koth_decision === team) || (st.phase === "gs_decision" && st.gs_eligible === team);
  const thinking = rel !== 0 && (isTurn || deciding) && ["playing", "trump_select", "koth_decision", "gs_decision"].includes(st.phase);
  return (
    <div data-testid={`player-seat-${player.seat}`} data-compact={compact ? "true" : undefined} data-mini={mini ? "true" : undefined}
      title={mini ? `${rel === 0 ? "You" : player.display_name || player.username} · ${TEAM_NAME[team]} · ${count} cards` : undefined}
      /* z-20 while the turn timer shows: the panel's backdrop blur makes it its own stacking context, so the
         timer badge on its border would otherwise be painted under the table board (z-10) where they meet. */
      className={`seat-panel relative ${hasTurnTimer && turnDeadline ? "z-20" : ""} flex ${compact ? "flex-row gap-1.5 px-2 py-1" : horizontal ? "flex-row gap-2 px-2.5 py-1.5 sm:gap-3 sm:px-3" : "flex-col gap-1 px-1.5 py-2 w-[70px] sm:w-[92px]"} items-center rounded-2xl border transition-[border-color,box-shadow,transform] duration-300 ${team === 0 ? "border-sky-300/25" : "border-amber-300/25"} ${isTurn ? "seat-panel-active border-amber-200/90 shadow-[0_0_24px_-3px_rgba(251,191,36,.6)]" : "bg-[#07120d]/75 shadow-[0_10px_28px_-18px_rgba(0,0,0,.9)]"} ${highlight ? "seat-panel-winner border-amber-200 shadow-[0_0_30px_4px_rgba(251,191,36,.55)]" : ""}`}>
      {hasTurnTimer && turnDeadline && <TurnTimer deadline={turnDeadline} phase={turnPhase} graceDeadline={turnGraceDeadline}
        duration={turnDuration} serverOffsetMs={serverOffsetMs} placement={rel === 2 ? "side" : "corner"} />}
      <motion.div className="relative shrink-0" animate={highlight ? { scale: [1, 1.15, 1.05] } : { scale: 1 }} transition={{ duration: 0.5 }}>
        {player.is_bot ? (
          <div className={!player.online ? "grayscale opacity-60 transition-[filter,opacity] duration-500" : "transition-[filter,opacity] duration-500"}>
            <PlayerAvatar user={player} size={avatarSize} ring={`ring-[3px] ring-team-${tl(team)} ${isTurn ? "turn-pulse" : ""}`} />
          </div>
        ) : (
          <Link to={`/profile/${encodeURIComponent(player.username)}`} className="block rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200"
            aria-label={`View ${player.display_name || player.username}'s profile`} data-testid={`seat-profile-link-${player.seat}`}>
            <div className={!player.online ? "grayscale opacity-60 transition-[filter,opacity] duration-500" : "transition-[filter,opacity] duration-500"}>
              <PlayerAvatar user={player} size={avatarSize} ring={`ring-[3px] ring-team-${tl(team)} ${isTurn ? "turn-pulse" : ""}`} />
            </div>
          </Link>
        )}
        {st.dealer === player.seat && <span className="absolute -top-1.5 -left-1.5 h-[18px] w-[18px] rounded-full bg-amber-300 text-slate-950 text-[9px] font-black flex items-center justify-center shadow" data-testid={`dealer-badge-${player.seat}`} aria-label="Dealer">D</span>}
        {player.online
          ? <span className="seat-online-badge absolute -bottom-1 -right-1 h-[13px] w-[13px] rounded-full border-2 border-[#07120d] bg-emerald-400" data-testid={`online-badge-${player.seat}`} aria-label="Connected" />
          : <span className="absolute -bottom-1 -right-1 h-[18px] w-[18px] rounded-full bg-rose-600 flex items-center justify-center" data-testid={`offline-badge-${player.seat}`} aria-label="Reconnecting"><WifiOff size={10} className="text-white" /></span>}
        <AnimatePresence>
          {reaction && (
            <motion.div key={reaction.id} initial={{ opacity: 0, y: 6, scale: 0.6 }} animate={{ opacity: 1, y: -28, scale: 1.2 }} exit={{ opacity: 0 }}
              className="absolute left-1/2 -translate-x-1/2 -top-2 text-3xl pointer-events-none z-10" data-testid={`seat-reaction-${player.seat}`}>{reaction.emoji}</motion.div>
          )}
        </AnimatePresence>
      </motion.div>
      {mini ? (
        <div className="flex flex-col text-left leading-tight">
          <span className="text-[10px] font-semibold text-white">{rel === 0 ? "You" : (player.display_name || player.username)}</span>
          <span className="font-mono text-[9px] text-white/60" data-testid={`seat-card-count-${player.seat}`}>{count} cards</span>
        </div>
      ) : (
      <div className={`min-w-0 ${horizontal ? "text-left" : "text-center w-full"}`}>
        <div className="text-[11px] sm:text-xs font-semibold text-white truncate">{rel === 0 ? "You" : player.is_bot ? player.username : <Link to={`/profile/${encodeURIComponent(player.username)}`} className="hover:text-amber-100" data-testid={`seat-username-link-${player.seat}`}>{player.display_name || player.username}</Link>}</div>
        {compact ? (
          <div className="flex items-center gap-1 whitespace-nowrap text-[9px]">
            <span className={`font-bold uppercase tracking-wider text-team-${tl(team)}`}>{rel === 2 ? `Partner · ${tl(team).toUpperCase()}` : TEAM_NAME[team]}</span>
            <span className="text-white/35">·</span>
            {player.is_bot && <span className="inline-flex items-center text-white/60" title="Bot" data-testid={`bot-badge-${player.seat}`}><Bot size={10} /></span>}
            <span className="font-mono text-white/60" data-testid={`seat-card-count-${player.seat}`}>{count} cards</span>
          </div>
        ) : (
          <>
            <div className={`text-[9px] sm:text-[10px] font-bold uppercase tracking-wider text-team-${tl(team)} truncate`}>{rel === 2 ? `Partner · ${tl(team).toUpperCase()}` : TEAM_NAME[team]}</div>
            <div className={`flex items-center gap-1 text-[9px] sm:text-[10px] text-white/60 whitespace-nowrap ${horizontal ? "" : "justify-center"}`}>
              {player.is_bot && <span className="inline-flex items-center" title="Bot" data-testid={`bot-badge-${player.seat}`}><Bot size={11} /></span>}
              <span className="font-mono" data-testid={`seat-card-count-${player.seat}`}>{count} cards</span>
            </div>
          </>
        )}
        {!player.online && <div className="text-[9px] text-rose-300">Reconnecting…</div>}
        {thinking && (
          <div className={`flex items-center gap-0.5 text-[9px] text-amber-200/90 ${horizontal ? "" : "justify-center"} ${compact ? "absolute -bottom-2 right-2 rounded-full bg-black/70 px-1.5" : ""}`} data-testid={`thinking-indicator-${player.seat}`}>
            <span className="thinking-dot" /><span className="thinking-dot" style={{ animationDelay: ".15s" }} /><span className="thinking-dot" style={{ animationDelay: ".3s" }} />
            <span className="ml-0.5 truncate">{player.is_bot ? "Bot" : "Thinking"}</span>
          </div>
        )}
      </div>
      )}
    </div>
  );
}

// Fixed slot per seat inside the dedicated trick grid: [top, left, right, bottom] by relative position.
const SLOT = { 0: "col-start-2 row-start-3", 1: "col-start-3 row-start-2", 2: "col-start-2 row-start-1", 3: "col-start-1 row-start-2" };
const FROM = [{ x: 0, y: 140 }, { x: 140, y: 0 }, { x: 0, y: -140 }, { x: -140, y: 0 }];
const TOWARD = [{ x: 0, y: 220 }, { x: 260, y: 0 }, { x: 0, y: -220 }, { x: -260, y: 0 }];
const ENTER_ROTATION = [0, 2, 0, -2];
const REST_ROTATION = [0, 0, 0, 0];

export function TrickSlots({ cards, currentTrick = [], mySeat, winner, children }) {
  return (
    <div className="relative grid grid-cols-[repeat(3,auto)] grid-rows-[repeat(3,auto)] place-items-center gap-x-0.5 gap-y-0 sm:gap-x-2 lg:gap-x-3 xl:gap-x-4" data-testid="center-trick-area">
      {[0, 1, 2, 3].map((rel) => <div key={rel} data-testid={`trick-card-slot-${rel}`} className={`trick-card-slot ${SLOT[rel]} rounded-lg border border-dashed border-white/10`} />)}
      <CurrentSuitIndicator trick={currentTrick} />
      <AnimatePresence>
        {cards.map(([seat, card]) => {
          const rel = relOf(seat, mySeat);
          const won = winner !== null && winner !== undefined;
          const toW = won ? TOWARD[relOf(winner, mySeat)] : null;
          return (
            <motion.div key={`${seat}-${card}`} className={`${SLOT[rel]} will-change-transform`}
              initial={{ ...FROM[rel], opacity: 0, rotate: ENTER_ROTATION[rel], scale: 1 }}
              animate={{ x: 0, y: won && winner === seat ? -3 : 0, opacity: won && winner !== seat ? 0.82 : 1, rotate: REST_ROTATION[rel], scale: won && winner === seat ? 1.08 : 1 }}
              exit={toW ? { ...toW, opacity: 0, scale: 0.5, transition: { duration: 0.45, ease: "easeIn" } } : { opacity: 0 }}
              transition={{ type: "spring", stiffness: 250, damping: 24 }}>
              <PlayingCard card={card} size="trick" testId={`trick-card-${seat}`}
                className={winner === seat ? "ring-[3px] ring-amber-400 shadow-[0_0_26px_rgba(251,191,36,.75)]" : "shadow-[0_6px_12px_-6px_rgba(0,0,0,.68)]"} />
            </motion.div>
          );
        })}
      </AnimatePresence>
      {children}
    </div>
  );
}

function contentWidth(el) {
  const style = window.getComputedStyle(el);
  return el.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
}

function viewportHeight() {
  return window.visualViewport?.height || window.innerHeight || Infinity;
}

function viewportWidth() {
  return window.visualViewport?.width || window.innerWidth || Infinity;
}

// Fan hand sized from the measured width AND screen height (see lib/handLayout.js), re-flowing as cards
// are played, the window resizes or the device rotates.
// sideStart / sideEnd: optional content placed beside the hand (landscape phones). sideReserve px of
// padding on each side keeps the measured hand width clear of them, so they can never overlap.
// Portrait phones with 7+ cards get two fanned rows (e.g. 7 + 6, see computeTwoRowHandLayout); everything
// else keeps the single row.
export function FanHand({ cards, legal, myTurn, onPlay, pending, onInvalid, sideStart = null, sideEnd = null, sideReserve = 0 }) {
  const box = useRef(null);
  const [w, setW] = useState(null);
  const [vh, setVh] = useState(viewportHeight);
  const [vw, setVw] = useState(viewportWidth);
  const [selected, setSelected] = useState(null);
  const [shake, setShake] = useState(null);
  const pointer = useRef("mouse");
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    setW(contentWidth(el)); // measure before the first paint instead of guessing a width
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    const onViewport = () => { setVh(viewportHeight()); setVw(viewportWidth()); };
    window.addEventListener("resize", onViewport);
    window.visualViewport?.addEventListener("resize", onViewport);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onViewport);
      window.visualViewport?.removeEventListener("resize", onViewport);
    };
  }, []);
  useEffect(() => { if (!cards.includes(selected)) setSelected(null); }, [cards, selected]);
  const layout = computeHandLayout({ width: w ?? 0, viewportHeight: vh, count: cards.length });
  const twoRow = usesTwoRows({ screenWidth: vw, count: cards.length, sideLayout: !!sideReserve })
    ? computeTwoRowHandLayout({ width: w ?? 0, viewportHeight: vh, count: cards.length })
    : null;
  const { cardWidth: cw, cardHeight: ch, total, height } = twoRow || layout;
  // Where card i goes: its row's layout, its index in that row, the row's offsets and its stacking order.
  const place = (i) => {
    if (!twoRow) return { L: layout, j: i, dx: 0, dy: 0, z: i + 1 };
    const { row, rowIndex, j } = rowOf(twoRow, i);
    return { L: row.layout, j, dx: row.offsetX, dy: row.offsetY, z: rowIndex * 20 + j + 1, rowIndex };
  };
  const legalSet = new Set(legal);
  const tap = (c) => {
    if (!myTurn || pending) return;
    if (!legalSet.has(c)) { setShake(c); setTimeout(() => setShake(null), 320); sound.play("invalid"); return onInvalid?.(); }
    if (pointer.current !== "mouse" && selected !== c) { setSelected(c); sound.play("pickup", { gain: 0.7 }); return; }
    setSelected(null);
    sound.play("pickup", { gain: 0.6 });
    onPlay(c);
  };
  return (
    <div ref={box} className={`game-hand-dock relative z-10 shrink-0 w-full mx-auto pl-[max(6px,env(safe-area-inset-left))] pr-[max(6px,env(safe-area-inset-right))] pt-1 pb-[max(12px,env(safe-area-inset-bottom))] ${sideReserve ? "" : "max-w-4xl"}`}
      style={sideReserve ? { paddingLeft: sideReserve, paddingRight: sideReserve } : undefined} data-testid="player-hand-container">
      {sideStart && <div className="absolute bottom-[max(12px,env(safe-area-inset-bottom))] left-[max(6px,env(safe-area-inset-left))] flex items-center gap-2" style={{ width: sideReserve - 12 }} data-testid="hand-side-start">{sideStart}</div>}
      {sideEnd && <div className="absolute bottom-[max(12px,env(safe-area-inset-bottom))] right-[max(6px,env(safe-area-inset-right))] flex items-center justify-end gap-2" style={{ width: sideReserve - 12 }} data-testid="hand-side-end">{sideEnd}</div>}
      <div className="relative mx-auto" style={{ width: total, height, visibility: w === null ? "hidden" : undefined }}
        data-testid="player-hand-fan" data-card-width={Math.round(cw)} data-rows={twoRow ? 2 : 1}>
        <AnimatePresence initial={false}>
          {cards.map((c, i) => {
            const playable = myTurn && legalSet.has(c) && !pending;
            const isSel = selected === c && playable;
            const at = place(i);
            const pose = cardPose(at.L, at.j, isSel ? "selected" : "rest");
            // A <button> centres its text by default, which would push the rank and suit under the next
            // card on phones (where each card shows only a narrow strip): keep them in the corner there.
            // Portrait phones: below the sm breakpoint. Landscape phones are wider than that, so they are
            // recognised by their side panels (sideReserve, set only for the landscape-phone layout).
            return (
              <motion.button key={c} type="button" data-sound="none" data-testid={`hand-card-${c}`} data-selected={isSel ? "true" : "false"} data-row={at.rowIndex} aria-disabled={!playable}
                onPointerDown={(e) => { pointer.current = e.pointerType; }} onClick={() => tap(c)}
                className={`absolute origin-bottom will-change-transform ${sideReserve ? "text-left" : "max-sm:text-left"} ${playable ? "cursor-pointer" : "cursor-default"} ${shake === c ? "shake" : ""}`}
                style={{ left: at.dx + pose.left, bottom: at.L.bottom + at.dy, width: cw, height: ch, zIndex: at.z }}
                initial={{ y: -200, opacity: 0, rotate: -6 }}
                animate={{ y: pose.y, opacity: 1, rotate: pose.rotate }}
                exit={{ y: -90, opacity: 0, transition: { duration: 0.2 } }}
                whileHover={playable ? { y: cardPose(at.L, at.j, "hover").y } : {}}
                transition={{ type: "spring", stiffness: 260, damping: 24 }}>
                <PlayingCard card={c} size="fluid" style={{ fontSize: at.L.fontSize }}
                  className={`${isSel ? "ring-[3px] ring-amber-300 shadow-[0_0_22px_rgba(251,191,36,.6)]" : playable ? "ring-2 ring-amber-300/70" : ""} ${myTurn && !legalSet.has(c) ? "brightness-[.55]" : ""}`} />
              </motion.button>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}
