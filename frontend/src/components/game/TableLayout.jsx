import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { WifiOff, Bot } from "lucide-react";
import { PlayerAvatar } from "@/components/PlayerAvatar";
import { PlayingCard } from "@/components/PlayingCard";
import { SUIT_SYMBOL, SUIT_NAME, TEAM_NAME, isRed, cardSuit } from "@/lib/api";
import { sound } from "@/lib/sound";

export const relOf = (seat, mySeat) => (seat - mySeat + 4) % 4;
const tl = (t) => (t === 0 ? "a" : "b");

function TenChip({ card }) {
  const s = cardSuit(card);
  return (
    <span data-testid={`captured-ten-${card}`} className={`inline-flex flex-col items-center justify-center w-[22px] h-[30px] sm:w-6 sm:h-8 rounded-[4px] bg-white shadow-md leading-none font-bold text-[9px] sm:text-[10px] ${isRed(s) ? "text-rose-600" : "text-slate-900"}`}>
      10<span className="text-[10px] sm:text-xs">{SUIT_SYMBOL[s]}</span>
    </span>
  );
}

function TeamScore({ st, team, mine, align }) {
  return (
    <div className={`flex flex-col ${align === "right" ? "items-end" : "items-start"} min-w-0`}>
      <div className={`flex items-baseline gap-1.5 ${align === "right" ? "flex-row-reverse" : ""}`}>
        <span className={`text-[10px] font-bold uppercase tracking-wider text-team-${tl(team)}`}>{TEAM_NAME[team]}{mine ? " •" : ""}</span>
        <span className="font-mono text-xl sm:text-2xl font-bold leading-none" data-testid={`score-team-${tl(team)}`}>{st.scores[team]}<span className="text-[10px] text-white/45">/{st.target}</span></span>
      </div>
      <div className={`flex items-center gap-1 mt-1 ${align === "right" ? "flex-row-reverse" : ""}`} data-testid={`tens-counter-team-${tl(team)}`}>
        <span className="font-mono text-[10px] text-white/60" data-testid={`tens-count-team-${tl(team)}`}>{st.tens[team].length}/4</span>
        {st.tens[team].map((c) => <TenChip key={c} card={c} />)}
        <span className="text-[10px] text-white/45 ml-1 mr-1 hidden sm:inline" data-testid={`tricks-team-${tl(team)}`}>· {st.tricks_won[team]} tricks</span>
      </div>
    </div>
  );
}

export function Hud({ st, left, right, connected }) {
  const myTeam = st.my_seat % 2;
  return (
    <div className="shrink-0 px-2 sm:px-4 pt-2 sm:pt-3" data-testid="match-scoreboard">
      <div className="mx-auto max-w-4xl rounded-2xl border border-white/10 bg-black/40 backdrop-blur-md px-2 sm:px-4 py-2 flex items-center gap-2 sm:gap-4 text-white shadow-[0_10px_30px_-12px_rgba(0,0,0,.7)]">
        {left}
        <div className="flex-1 min-w-0"><TeamScore st={st} team={0} mine={myTeam === 0} /></div>
        <div className="flex flex-col items-center shrink-0" data-testid="trump-indicator-badge" title={st.trump ? SUIT_NAME[st.trump] : "Trump not chosen"}>
          <div className={`h-9 w-9 sm:h-11 sm:w-11 rounded-full border-2 border-amber-400/60 bg-black/50 flex items-center justify-center text-xl sm:text-2xl ${st.trump && isRed(st.trump) ? "text-rose-400" : "text-white"}`}>
            {st.trump ? SUIT_SYMBOL[st.trump] : "?"}
          </div>
          <span className="text-[9px] uppercase tracking-widest text-amber-200/70 mt-0.5">Trump</span>
        </div>
        <div className="flex-1 min-w-0"><TeamScore st={st} team={1} mine={myTeam === 1} align="right" /></div>
        {right}
      </div>
      <div className="mx-auto max-w-4xl flex items-center justify-center gap-3 mt-1 text-[10px] sm:text-[11px] font-mono text-white/65 whitespace-nowrap" data-testid="round-info">
        <span>Round {st.round_no} · Trick {Math.min(st.tricks_played + (st.trick.length ? 1 : 0), 13)}/13</span>
        <span data-testid="connection-status" className={`inline-flex items-center gap-1 ${connected ? "text-emerald-300" : "text-amber-300"}`}>
          {connected ? <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> : <WifiOff size={11} className="animate-pulse" />}{connected ? "Live" : "Reconnecting"}
        </span>
        {st.koth !== null && <span className="text-amber-300 font-sans font-bold" data-testid="koth-active-badge">KOTH · {TEAM_NAME[st.koth]}</span>}
        {st.gs_declared !== null && <span className="text-rose-300 font-sans font-bold" data-testid="grand-slam-active-badge">GRAND SLAM · {TEAM_NAME[st.gs_declared]}</span>}
      </div>
    </div>
  );
}

export function SeatPanel({ player, st, mySeat, reaction, pending = 0, highlight, dealing, horizontal }) {
  const rel = relOf(player.seat, mySeat);
  const team = player.team;
  const isTurn = st.turn === player.seat || (st.phase === "trump_select" && st.trump_selector === player.seat && !dealing);
  const count = Math.max(0, st.hand_counts[player.seat] - pending);
  const deciding = (st.phase === "koth_decision" && st.koth_decision === team) || (st.phase === "gs_decision" && st.gs_eligible === team);
  const thinking = rel !== 0 && (isTurn || deciding) && ["playing", "trump_select", "koth_decision", "gs_decision"].includes(st.phase);
  return (
    <div data-testid={`player-seat-${player.seat}`}
      className={`relative flex ${horizontal ? "flex-row gap-2 px-2.5 py-1.5" : "flex-col gap-1 px-1.5 py-2 w-[70px] sm:w-[92px]"} items-center rounded-2xl border bg-black/45 backdrop-blur-md transition-[border-color,box-shadow] duration-300 ${isTurn ? "border-amber-300/80 shadow-[0_0_22px_-2px_rgba(251,191,36,.55)]" : "border-white/10"} ${highlight ? "shadow-[0_0_30px_4px_rgba(251,191,36,.6)] border-amber-300" : ""}`}>
      <motion.div className="relative shrink-0" animate={highlight ? { scale: [1, 1.15, 1.05] } : { scale: 1 }} transition={{ duration: 0.5 }}>
        <div className={!player.online ? "grayscale opacity-60 transition-[filter,opacity] duration-500" : "transition-[filter,opacity] duration-500"}>
          <PlayerAvatar user={player} size={horizontal ? 34 : 38} ring={`ring-[3px] ring-team-${tl(team)} ${isTurn ? "turn-pulse" : ""}`} />
        </div>
        {st.dealer === player.seat && <span className="absolute -top-1.5 -left-1.5 h-[18px] w-[18px] rounded-full bg-amber-400 text-slate-950 text-[9px] font-black flex items-center justify-center shadow" data-testid={`dealer-badge-${player.seat}`}>D</span>}
        {!player.online && <span className="absolute -bottom-1 -right-1 h-[18px] w-[18px] rounded-full bg-rose-600 flex items-center justify-center" data-testid={`offline-badge-${player.seat}`}><WifiOff size={10} className="text-white" /></span>}
        <AnimatePresence>
          {reaction && (
            <motion.div key={reaction.id} initial={{ opacity: 0, y: 6, scale: 0.6 }} animate={{ opacity: 1, y: -28, scale: 1.2 }} exit={{ opacity: 0 }}
              className="absolute left-1/2 -translate-x-1/2 -top-2 text-3xl pointer-events-none z-10" data-testid={`seat-reaction-${player.seat}`}>{reaction.emoji}</motion.div>
          )}
        </AnimatePresence>
      </motion.div>
      <div className={`min-w-0 ${horizontal ? "text-left" : "text-center w-full"}`}>
        <div className="text-[11px] sm:text-xs font-semibold text-white truncate">{rel === 0 ? "You" : player.username}</div>
        <div className={`text-[9px] sm:text-[10px] font-bold uppercase tracking-wider text-team-${tl(team)} truncate`}>{rel === 2 ? `Partner · ${tl(team).toUpperCase()}` : TEAM_NAME[team]}</div>
        <div className={`flex items-center gap-1 text-[9px] sm:text-[10px] text-white/60 whitespace-nowrap ${horizontal ? "" : "justify-center"}`}>
          {player.is_bot && <span className="inline-flex items-center" title="Bot" data-testid={`bot-badge-${player.seat}`}><Bot size={11} /></span>}
          <span className="font-mono" data-testid={`seat-card-count-${player.seat}`}>{count} cards</span>
        </div>
        {!player.online && <div className="text-[9px] text-rose-300">Reconnecting…</div>}
        {thinking && (
          <div className={`flex items-center gap-0.5 text-[9px] text-amber-200/90 ${horizontal ? "" : "justify-center"}`} data-testid={`thinking-indicator-${player.seat}`}>
            <span className="thinking-dot" /><span className="thinking-dot" style={{ animationDelay: ".15s" }} /><span className="thinking-dot" style={{ animationDelay: ".3s" }} />
            <span className="ml-0.5 truncate">{player.is_bot ? "Bot" : "Thinking"}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// Fixed slot per seat inside the dedicated trick grid: [top, left, right, bottom] by relative position.
const SLOT = { 0: "col-start-2 row-start-3", 1: "col-start-3 row-start-2", 2: "col-start-2 row-start-1", 3: "col-start-1 row-start-2" };
const FROM = [{ x: 0, y: 140 }, { x: 140, y: 0 }, { x: 0, y: -140 }, { x: -140, y: 0 }];
const TOWARD = [{ x: 0, y: 220 }, { x: 260, y: 0 }, { x: 0, y: -220 }, { x: -260, y: 0 }];

export function TrickSlots({ cards, mySeat, winner, children }) {
  return (
    <div className="relative grid grid-cols-[repeat(3,auto)] grid-rows-[repeat(3,auto)] place-items-center gap-x-1 gap-y-0 sm:gap-x-3" data-testid="center-trick-area">
      {[0, 1, 2, 3].map((rel) => <div key={rel} className={`${SLOT[rel]} w-[54px] h-[76px] sm:w-16 sm:h-[90px] lg:w-[78px] lg:h-[110px] rounded-lg border border-dashed border-white/10`} />)}
      <div className="col-start-2 row-start-2 w-[54px] h-[30px] sm:w-16 sm:h-10" />
      <AnimatePresence>
        {cards.map(([seat, card], i) => {
          const rel = relOf(seat, mySeat);
          const won = winner !== null && winner !== undefined;
          const toW = won ? TOWARD[relOf(winner, mySeat)] : null;
          return (
            <motion.div key={`${seat}-${card}`} className={`${SLOT[rel]} z-[${i + 1}]`} style={{ zIndex: i + 1 }}
              initial={{ ...FROM[rel], opacity: 0, rotate: rel * 9 - 14, scale: 0.92 }}
              animate={{ x: 0, y: 0, opacity: won && winner !== seat ? 0.82 : 1, rotate: ((seat * 7) % 7) - 3, scale: winner === seat ? 1.08 : 1 }}
              exit={toW ? { ...toW, opacity: 0, scale: 0.5, transition: { duration: 0.45, ease: "easeIn" } } : { opacity: 0 }}
              transition={{ type: "spring", stiffness: 250, damping: 24 }}>
              <PlayingCard card={card} size="trick" testId={`trick-card-${seat}`}
                className={winner === seat ? "ring-[3px] ring-amber-400 shadow-[0_0_26px_rgba(251,191,36,.7)]" : "shadow-[0_14px_24px_-10px_rgba(0,0,0,.8)]"} />
            </motion.div>
          );
        })}
      </AnimatePresence>
      {children}
    </div>
  );
}

// Fan hand sized from the available width so it never clips, re-flowing as cards are played.
export function FanHand({ cards, legal, myTurn, onPlay, pending, onInvalid }) {
  const box = useRef(null);
  const [w, setW] = useState(360);
  const [selected, setSelected] = useState(null);
  const [shake, setShake] = useState(null);
  const pointer = useRef("mouse");
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { if (!cards.includes(selected)) setSelected(null); }, [cards, selected]);
  const n = Math.max(cards.length, 1);
  const show = w < 480 ? 0.5 : 0.56;
  const usable = w - 28; // side margin so rotated edge cards never clip
  const cw = Math.max(40, Math.min(w < 640 ? 76 : 96, usable / (1 + (n - 1) * show)));
  const ch = cw * 1.4;
  const step = n > 1 ? Math.min(cw * 0.98, (usable - cw) / (n - 1)) : 0;
  const total = cw + step * (n - 1);
  const maxRot = Math.min(2.2, 22 / n);
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
    <div ref={box} className="shrink-0 w-full max-w-3xl mx-auto px-1.5 pb-[max(18px,env(safe-area-inset-bottom))]" data-testid="player-hand-container">
      <div className="relative mx-auto" style={{ width: total, height: ch + 34 }}>
        <AnimatePresence initial={false}>
          {cards.map((c, i) => {
            const mid = (n - 1) / 2;
            const off = i - mid;
            const playable = myTurn && legalSet.has(c) && !pending;
            const isSel = selected === c && playable;
            return (
              <motion.button key={c} type="button" data-sound="none" data-testid={`hand-card-${c}`} data-selected={isSel ? "true" : "false"} aria-disabled={!playable}
                onPointerDown={(e) => { pointer.current = e.pointerType; }} onClick={() => tap(c)}
                className={`absolute bottom-3 origin-bottom ${playable ? "cursor-pointer" : "cursor-default"} ${shake === c ? "shake" : ""}`}
                style={{ left: i * step, width: cw, height: ch, zIndex: i + 1 }}
                initial={{ y: -200, opacity: 0, rotate: -6 }}
                animate={{ y: isSel ? -22 : Math.abs(off) * Math.min(1.6, 16 / n), opacity: 1, rotate: isSel ? 0 : off * maxRot }}
                exit={{ y: -90, opacity: 0, transition: { duration: 0.2 } }}
                whileHover={playable ? { y: -18 } : {}}
                transition={{ type: "spring", stiffness: 260, damping: 24 }}>
                <PlayingCard card={c} size="fluid" style={{ fontSize: Math.max(11, cw * 0.21) }}
                  className={`${isSel ? "ring-[3px] ring-amber-300 shadow-[0_0_22px_rgba(251,191,36,.6)]" : playable ? "ring-2 ring-amber-300/70" : ""} ${myTurn && !legalSet.has(c) ? "brightness-[.55]" : ""}`} />
              </motion.button>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}
