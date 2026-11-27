import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, ArrowRight, ChevronsUp, Medal, X } from "lucide-react";
import { useApp, useSocketEvent } from "@/context/AppContext";
import { sound } from "@/lib/sound";
import { signed, victoryName } from "@/components/medals/medalText";
import { LeagueBadge, LEAGUE_NAME, LEAGUE_THEME, leagueLabel } from "@/components/leagues/League";

// Plays the player's progression events one at a time: medal earned / deducted, level up / down, and
// league promotion / demotion. Events come only from the server (GET /progression/events after a load or
// reconnect, and "progression_event" socket pushes); each id is shown at most once per page and is
// acknowledged on the server when it has been presented or dismissed, so a refresh never replays it.
// Nothing here blocks the game: toasts sit at the top and only the card itself takes clicks.

export const TIMING = { medal: 3600, level: 4200, league: 8000 };
const prefersReducedMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const KIND_ORDER = { medal: 0, level: 1, league: 2 };
const fmt = (n) => Number(n || 0).toLocaleString("en-IN");

function useCountTo(from, to, ms, reduced) {
  const [value, setValue] = useState(reduced ? to : from);
  useEffect(() => {
    if (reduced || from === to) { setValue(to); return undefined; }
    const start = Date.now();
    const id = setInterval(() => {
      const t = Math.min(1, (Date.now() - start) / ms);
      setValue(Math.round(from + (to - from) * (1 - (1 - t) ** 3)));
      if (t >= 1) clearInterval(id);
    }, 40);
    return () => clearInterval(id);
  }, [from, to, ms, reduced]);
  return value;
}

function CloseButton({ onClick, label = "Dismiss" }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} data-testid="progression-dismiss"
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white/50 hover:bg-white/10 hover:text-white"><X size={14} /></button>
  );
}

// A. / B. Medals earned (medals fly into the counter) or deducted (a quiet red count-down).
export function MedalToast({ event, reduced, onDone, extra }) {
  const d = event.data || {};
  const change = Number(d.change) || 0;
  const earned = d.won !== false && change >= 0;
  const before = Math.max(0, Number(d.balance_before ?? (d.balance_after - change)) || 0);
  const after = Math.max(0, Number(d.balance_after) || 0);
  const shown = useCountTo(before, after, 900, reduced);
  const name = victoryName(d.victory_type);
  const lines = earned
    ? [d.trick_medals ? `${d.tricks} trick${d.tricks === 1 ? "" : "s"} ${signed(d.trick_medals)}` : null,
      d.ten_medals ? `${d.tens} ten${d.tens === 1 ? "" : "s"} bonus ${signed(d.ten_medals)}` : null,
      d.bonus ? `${name} win bonus ${signed(d.bonus)}` : null].filter(Boolean)
    : [`${name} loss penalty ${signed(-(d.penalty || 0))}`,
      Math.abs(change) < (d.penalty || 0) ? `${Math.abs(change)} taken · medals never go below 0` : null].filter(Boolean);
  return (
    <motion.div role="status" aria-live="polite" data-testid="progression-medal" data-kind={earned ? "earned" : "deducted"}
      className={`pointer-events-auto relative w-[min(92vw,360px)] overflow-hidden rounded-2xl border px-3 py-2.5 shadow-[0_18px_40px_-14px_rgba(0,0,0,.95)] backdrop-blur ${earned
        ? "border-orange-300/45 bg-gradient-to-br from-[#2a1a0a]/95 to-[#100c08]/95" : "border-rose-300/30 bg-gradient-to-br from-[#2a0f14]/95 to-[#0f0a0c]/95"}`}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: -16, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -10 }}
      transition={{ duration: reduced ? 0.15 : 0.3 }}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className={`text-[10px] font-bold uppercase tracking-[0.16em] ${earned ? "text-orange-200/85" : "text-rose-200/80"}`}>
            {earned ? "Medals earned" : "Medals deducted"} · round {d.round}
          </div>
          <div className={`mt-0.5 font-mono text-xl font-black ${earned ? "text-amber-100" : "text-rose-200"}`} data-testid="progression-medal-change">{signed(change)}</div>
          <ul className="mt-0.5 space-y-px text-[11px] text-white/60" data-testid="progression-medal-reason">
            {lines.map((l) => <li key={l}>{l}</li>)}
          </ul>
        </div>
        <div className="relative flex flex-col items-center">
          {earned && !reduced && change > 0 && Array.from({ length: Math.min(6, Math.max(2, Math.ceil(change / 3))) }, (_, i) => (
            <motion.span key={i} className="absolute text-amber-300" aria-hidden="true" data-testid="progression-flying-medal"
              initial={{ x: -120 - i * 8, y: -10 + (i % 3) * 10, opacity: 0, scale: 0.6 }}
              animate={{ x: 0, y: 0, opacity: [0, 1, 1, 0], scale: [0.6, 1.1, 0.8] }}
              transition={{ duration: 0.65, delay: 0.15 + i * 0.09, ease: "easeIn" }}>
              <Medal size={16} />
            </motion.span>
          ))}
          <span className={`flex items-center gap-1 rounded-xl border px-2.5 py-1 font-mono text-lg font-black ${earned ? "border-orange-300/40 bg-orange-300/15 text-orange-100" : "border-rose-300/30 bg-rose-500/10 text-rose-100"}`}
            data-testid="progression-medal-counter" aria-label={`Medal balance ${after}`}>
            <Medal size={15} aria-hidden="true" />{fmt(shown)}
          </span>
          <span className="mt-0.5 text-[9px] uppercase tracking-wider text-white/40">balance</span>
        </div>
        <CloseButton onClick={onDone} />
      </div>
      {extra}
    </motion.div>
  );
}

// C. Level up (a bright pop) or level down (a quiet note) inside the same league.
export function LevelToast({ event, reduced, onDone, extra }) {
  const d = event.data || {};
  const up = d.direction === "up";
  const to = { id: d.to?.league, level: d.to?.level };
  const from = { id: d.from?.league, level: d.from?.level };
  return (
    <motion.div role="status" aria-live="polite" data-testid="progression-level" data-direction={d.direction}
      className={`pointer-events-auto relative w-[min(92vw,360px)] overflow-hidden rounded-2xl border px-3 py-3 shadow-[0_18px_40px_-14px_rgba(0,0,0,.95)] backdrop-blur ${up
        ? "border-amber-200/60 bg-gradient-to-br from-[#2c2208]/95 to-[#0f0c06]/95" : "border-white/15 bg-[#10141f]/95"}`}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: -16, scale: 0.92 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -10 }}
      transition={reduced ? { duration: 0.15 } : { type: "spring", stiffness: 300, damping: 20 }}>
      {up && !reduced && (
        <motion.span className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_75%_50%,rgba(251,191,36,.35),transparent_60%)]" aria-hidden="true"
          initial={{ opacity: 0 }} animate={{ opacity: [0, 1, 0.4] }} transition={{ duration: 1.2 }} />
      )}
      <div className="relative flex items-center gap-3">
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${up ? "bg-amber-300 text-slate-950" : "bg-white/10 text-white/60"}`} aria-hidden="true">
          {up ? <ChevronsUp size={18} /> : <ArrowDown size={16} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className={`text-[10px] font-bold uppercase tracking-[0.16em] ${up ? "text-amber-200" : "text-white/55"}`}>{up ? "Level up!" : "Level down"}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm font-semibold text-white" data-testid="progression-level-change">
            <span className="text-white/60">{leagueLabel(from)}</span><ArrowRight size={13} className="text-white/40" aria-hidden="true" /><span>{leagueLabel(to)}</span>
          </div>
          <div className="text-[11px] text-white/55">Balance <b className="font-mono text-white/80">{fmt(d.balance_after)}</b> medals</div>
        </div>
        <motion.span initial={reduced ? false : { scale: 0.3, rotate: -20 }} animate={{ scale: 1, rotate: 0 }}
          transition={{ delay: 0.25, type: "spring", stiffness: 260, damping: 12 }}>
          <LeagueBadge league={to} size={44} />
        </motion.span>
        <CloseButton onClick={onDone} />
      </div>
      {extra}
    </motion.div>
  );
}

// D. League promotion (a full celebration) or demotion (a respectful note). Only the card takes clicks.
export function LeagueCard({ event, reduced, onDone, extra }) {
  const d = event.data || {};
  const promoted = d.direction === "promotion";
  const to = { id: d.to?.league, level: d.to?.level };
  const theme = LEAGUE_THEME[to.id] || LEAGUE_THEME.bronze;
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onDone(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);
  return (
    <motion.div role="dialog" aria-modal="false" aria-labelledby="progression-league-title" data-testid="progression-league" data-direction={d.direction}
      className={`pointer-events-auto relative w-[min(92vw,380px)] overflow-hidden rounded-3xl border-2 p-5 text-center shadow-[0_30px_80px_-20px_rgba(0,0,0,.95)] ${promoted
        ? "border-amber-200/60 bg-gradient-to-b from-[#2a2010] via-[#16110a] to-[#0b0906]" : "border-white/15 bg-gradient-to-b from-[#141a28] to-[#0b0f18]"}`}
      initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.85, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95 }}
      transition={reduced ? { duration: 0.15 } : { type: "spring", stiffness: 220, damping: 20 }}>
      {promoted && !reduced && (
        <>
          <motion.span className="pointer-events-none absolute left-1/2 top-[30%] h-[420px] w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-full" aria-hidden="true"
            style={{ background: `conic-gradient(from 0deg, transparent 0 8%, ${theme.glow} 10%, transparent 12% 24%, ${theme.glow} 26%, transparent 28% 40%, ${theme.glow} 42%, transparent 44% 56%, ${theme.glow} 58%, transparent 60% 72%, ${theme.glow} 74%, transparent 76% 88%, ${theme.glow} 90%, transparent 92%)`, opacity: 0.35 }}
            animate={{ rotate: 360 }} transition={{ duration: 18, repeat: Infinity, ease: "linear" }} data-testid="progression-league-rays" />
          {Array.from({ length: 14 }, (_, i) => (
            <motion.span key={i} className="pointer-events-none absolute left-1/2 top-[30%] h-1.5 w-1.5 rounded-full bg-amber-200" aria-hidden="true"
              initial={{ x: 0, y: 0, opacity: 1 }} animate={{ x: Math.cos((i / 14) * Math.PI * 2) * 140, y: Math.sin((i / 14) * Math.PI * 2) * 110, opacity: 0 }}
              transition={{ duration: 1.1, delay: 0.35, ease: "easeOut" }} />
          ))}
        </>
      )}
      <div className="relative">
        <div className={`text-[10px] font-bold uppercase tracking-[0.2em] ${promoted ? "text-amber-200/80" : "text-white/50"}`}>{promoted ? "League promotion" : "League change"}</div>
        <motion.div className="mx-auto mt-3 w-fit" initial={reduced ? false : { scale: 0.2, rotate: -30, opacity: 0 }} animate={{ scale: 1, rotate: 0, opacity: 1 }}
          transition={{ delay: 0.15, type: "spring", stiffness: 200, damping: promoted ? 10 : 18 }}>
          <LeagueBadge league={to} size={promoted ? 96 : 72} testId="progression-league-badge" />
        </motion.div>
        <h2 id="progression-league-title" className={`mt-3 font-display text-3xl ${promoted ? "text-amber-50" : "text-white/90"}`}>
          {promoted ? `${LEAGUE_NAME[to.id]} League!` : `You moved to ${LEAGUE_NAME[to.id]}`}
        </h2>
        <p className="mt-1 text-sm text-white/65" data-testid="progression-league-detail">
          {leagueLabel(to)} · <b className="font-mono text-white/85">{fmt(d.balance_after)}</b> medals
        </p>
        <p className="mt-1 text-xs text-white/45">
          {promoted ? `Up from ${leagueLabel({ id: d.from?.league, level: d.from?.level })}.` : `Down from ${leagueLabel({ id: d.from?.league, level: d.from?.level })}. Win rounds to climb back — your highest league is kept.`}
        </p>
        <button type="button" className={`mt-4 ${promoted ? "btn-gold" : "btn-ghost"} !px-6`} onClick={onDone} data-testid="progression-continue">Continue</button>
        {extra}
      </div>
    </motion.div>
  );
}

export function ProgressionPresenter() {
  const { api, refreshMe } = useApp();
  const [queue, setQueue] = useState([]);
  const seen = useRef(new Set());
  const reduced = prefersReducedMotion();

  const enqueue = useCallback((events) => {
    const fresh = (events || []).filter((e) => e && e.id && !e.acknowledged && !seen.current.has(e.id));
    if (!fresh.length) return;
    fresh.forEach((e) => seen.current.add(e.id));
    // Oldest first; within one round the medal change comes before any level or league change.
    const key = (e) => `${e.created_at || ""}|${e.id.split(":").slice(0, -1).join(":")}|${KIND_ORDER[e.kind] ?? 9}`;
    setQueue((q) => [...q, ...fresh].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)));
  }, []);

  useEffect(() => {
    api.get("/progression/events").then((r) => enqueue(r.data?.events)).catch(() => {});
  }, [api, enqueue]);
  useSocketEvent((m) => {
    if (m.type === "progression_event") enqueue([m.event]);
    if (m.type === "hello") api.get("/progression/events").then((r) => enqueue(r.data?.events)).catch(() => {});
  });

  const acknowledge = useCallback((ids) => {
    if (ids.length) api.post("/progression/events/ack", { ids }).catch(() => {});
  }, [api]);

  const current = queue[0];
  const finish = useCallback(() => {
    if (!current) return;
    acknowledge([current.id]);
    if (current.kind !== "medal") refreshMe?.();
    setQueue((q) => q.filter((e) => e.id !== current.id));
  }, [current, acknowledge, refreshMe]);
  const skipAll = useCallback(() => {
    acknowledge(queue.map((e) => e.id));
    setQueue([]);
    refreshMe?.();
  }, [queue, acknowledge, refreshMe]);

  // Each event plays for a while and then moves on by itself; it can also be dismissed early.
  useEffect(() => {
    if (!current) return undefined;
    if (current.kind === "league") sound.chime?.(current.data?.direction === "promotion" ? "ten_gain" : "ten_loss");
    else if (current.kind === "level" && current.data?.direction === "up") sound.chime?.("trick_gain");
    const t = setTimeout(finish, TIMING[current.kind] || TIMING.medal);
    return () => clearTimeout(t);
  }, [current]); // eslint-disable-line react-hooks/exhaustive-deps

  const more = queue.length - 1;
  const extra = more > 0 ? (
    <button type="button" onClick={skipAll} className="mt-2 text-[11px] font-semibold text-white/50 underline-offset-2 hover:text-white hover:underline" data-testid="progression-skip-all">
      Skip all ({more + 1})
    </button>
  ) : null;
  const big = current?.kind === "league";
  return (
    <div className={`pointer-events-none fixed inset-x-0 z-[70] flex justify-center px-3 ${big ? "inset-y-0 items-center" : "top-3 sm:top-4"}`} data-testid="progression-presenter">
      <AnimatePresence mode="wait">
        {current && current.kind === "medal" && <MedalToast key={current.id} event={current} reduced={reduced} onDone={finish} extra={extra} />}
        {current && current.kind === "level" && <LevelToast key={current.id} event={current} reduced={reduced} onDone={finish} extra={extra} />}
        {current && current.kind === "league" && <LeagueCard key={current.id} event={current} reduced={reduced} onDone={finish} extra={extra} />}
      </AnimatePresence>
    </div>
  );
}
